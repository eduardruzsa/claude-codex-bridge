// Small macOS adapter. No third-party libraries; built with Apple's Command Line Tools.
#include <sys/types.h>
#include <sys/sysctl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/proc.h>
#include <libproc.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int info(int pid) {
  struct proc_bsdinfo p;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &p, sizeof(p)) != sizeof(p)) return 1;
  printf("%u %llu%06llu %u %s\n", p.pbi_pid, p.pbi_start_tvsec,
         p.pbi_start_tvusec, p.pbi_ppid, p.pbi_status == SZOMB ? "Z" : "R");
  fwrite(p.pbi_comm, 1, strnlen(p.pbi_comm, sizeof(p.pbi_comm)), stdout);
  putchar(0);
  int mib[] = { CTL_KERN, KERN_PROCARGS2, pid };
  int argmax = 0;
  size_t size = sizeof(argmax);
  int maxmib[] = { CTL_KERN, KERN_ARGMAX };
  if (sysctl(maxmib, 2, &argmax, &size, NULL, 0) || argmax < (int)sizeof(int)) return 1;
  char *buf = calloc(1, argmax);
  if (!buf) return 1;
  size = argmax;
  if (sysctl(mib, 3, buf, &size, NULL, 0)) { free(buf); return 0; }
  int argc;
  memcpy(&argc, buf, sizeof(argc));
  char *s = buf + sizeof(argc), *end = buf + size;
  while (s < end && *s) s++; // executable path
  while (s < end && !*s) s++;
  for (int i = 0; i < argc && s < end; i++) {
    size_t len = strnlen(s, end - s);
    if (s + len == end) break;
    fwrite(s, 1, len + 1, stdout);
    s += len + 1;
  }
  free(buf);
  return 0;
}

static void files(int pid) {
  int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
  if (bytes <= 0) return;
  bytes += 32 * sizeof(struct proc_fdinfo);
  struct proc_fdinfo *fds = malloc(bytes);
  if (!fds) return;
  int count = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, bytes) / sizeof(*fds);
  for (int i = 0; i < count; i++) {
    if (fds[i].proc_fdtype != PROX_FDTYPE_VNODE) continue;
    struct vnode_fdinfowithpath v;
    if (proc_pidfdinfo(pid, fds[i].proc_fd, PROC_PIDFDVNODEPATHINFO, &v, sizeof(v)) != sizeof(v)) continue;
    const char *p = v.pvip.vip_path;
    size_t len = strnlen(p, sizeof(v.pvip.vip_path));
    // Only rollout paths are needed; never emit unrelated filenames.
    if (len < sizeof(v.pvip.vip_path) && strstr(p, "/rollout-")) fwrite(p, 1, len + 1, stdout);
  }
  free(fds);
}

static int lock_file(const char *path) {
  int fd = open(path, O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
  if (fd < 0) return 1;
  struct stat st;
  if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_uid != getuid()) return 1;
  if (fchmod(fd, 0600)) return 1;
  if (flock(fd, LOCK_EX | LOCK_NB)) return errno == EWOULDBLOCK ? 75 : 1;
  puts("locked");
  fflush(stdout);
  // The parent's pipe closes even on SIGKILL. Never unlink a lock inode.
  char c;
  for (;;) {
    ssize_t n = read(STDIN_FILENO, &c, 1);
    if (n > 0 || (n < 0 && errno == EINTR)) continue;
    break;
  }
  close(fd);
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 3 && !strcmp(argv[1], "lock")) return lock_file(argv[2]);
  if (argc == 3 && !strcmp(argv[1], "info")) return info(atoi(argv[2]));
  if (argc == 3 && !strcmp(argv[1], "files")) {
    int pid = atoi(argv[2]);
    if (pid > 0) { files(pid); return 0; }
    int bytes = proc_listpids(PROC_UID_ONLY, getuid(), NULL, 0);
    if (bytes <= 0) return 1;
    bytes += 256 * sizeof(pid_t);
    pid_t *pids = malloc(bytes);
    if (!pids) return 1;
    int count = proc_listpids(PROC_UID_ONLY, getuid(), pids, bytes) / sizeof(pid_t);
    for (int i = 0; i < count; i++) if (pids[i] > 0) files(pids[i]);
    free(pids);
    return 0;
  }
  return 2;
}
