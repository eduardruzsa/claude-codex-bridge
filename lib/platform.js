// OS-specific process inspection and kernel locks. Linux keeps its /proc and
// abstract sockets; macOS uses libproc/sysctl and flock through a small helper.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import { spawn, spawnSync, execFileSync } from 'node:child_process'

let native
export function macHelper() {
  if (native) return native
  const source = path.resolve(import.meta.dirname, '../native/macos.c')
  const hash = crypto.createHash('sha256').update(fs.readFileSync(source)).update(process.arch).digest('hex').slice(0, 16)
  const dir = path.resolve(import.meta.dirname, '../.native')
  const target = path.join(dir, `macos-${hash}`)
  if (!fs.existsSync(target)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temp = `${target}.${process.pid}.tmp`
    try {
      const r = spawnSync('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', source, '-o', temp], { encoding: 'utf8', timeout: 60000 })
      if (r.status !== 0) throw new Error(`macOS helper build failed. Install Xcode Command Line Tools (xcode-select --install). ${r.stderr || r.error?.message || ''}`)
      fs.chmodSync(temp, 0o700)
      fs.renameSync(temp, target)
    } finally { fs.rmSync(temp, { force: true }) }
  }
  native = target
  return target
}

export function processInfo(pid = process.pid) {
  try {
    if (process.platform === 'darwin') {
      const raw = execFileSync(macHelper(), ['info', String(pid)], { timeout: 3000, encoding: 'utf8' })
      const nl = raw.indexOf('\n')
      const [id, start, parent, state] = raw.slice(0, nl).split(' ')
      const [comm, ...args] = raw.slice(nl + 1).split('\0')
      args.pop()
      return { pid: Number(id), start, parent: Number(parent), state, comm, args }
    }
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
    let args = []
    try { args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) } catch {}
    return { pid: Number(pid), start: fields[19], parent: Number(fields[1]), state: fields[0],
      comm: raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')')), args }
  } catch { return null }
}

export function openRolloutThreads(pid) {
  const threads = new Set()
  const add = target => {
    const match = target.match(/\/rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
    if (match) threads.add(match[1].toLowerCase())
  }
  if (process.platform === 'darwin') {
    const out = execFileSync(macHelper(), ['files', String(pid || 0)], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 })
    for (const file of out.split('\0')) add(file)
  } else {
    for (const p of pid ? [String(pid)] : fs.readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
      try {
        for (const fd of fs.readdirSync(`/proc/${p}/fd`)) {
          try { add(fs.readlinkSync(`/proc/${p}/fd/${fd}`)) } catch {}
        }
      } catch {}
    }
  }
  return threads
}

// Returns a close(callback) handle, like net.Server. A macOS helper holds flock
// until its parent's pipe closes. Unexpected lock loss terminates the owner.
// wait (ms) applies on macOS only; withMutex retries the cheap Linux bind itself.
export async function acquireMutex(name, directory, wait = 0) {
  if (process.platform !== 'darwin') {
    const server = net.createServer(c => c.destroy())
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(name, resolve) })
    return server
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.chmodSync(directory, 0o700)
  const key = crypto.createHash('sha256').update(name).digest('hex')
  const child = spawn(macHelper(), ['lock', path.join(directory, `${key}.lock`), String(Math.max(0, Math.round(wait)))], { stdio: ['pipe', 'pipe', 'pipe'] })
  return new Promise((resolve, reject) => {
    let acquired = false, closing = false, error = ''
    child.stderr.on('data', d => error += d)
    child.stdin.on('error', () => {})
    child.once('error', reject)
    child.once('exit', code => {
      if (!acquired) reject(Object.assign(new Error(error || `lock helper exited ${code}`), { code: code === 75 ? 'EADDRINUSE' : 'ELOCK' }))
      else if (!closing) { console.error('cc-bridge: kernel lock lost; stopping to preserve exclusive ownership'); process.exit(1) }
    })
    child.stdout.once('data', () => {
      acquired = true
      resolve({ close(callback) {
        closing = true
        if (child.exitCode !== null) callback?.()
        else { if (callback) child.once('exit', callback); child.stdin.end() }
      } })
    })
  })
}

export async function withMutex(name, directory, fn, timeout = 3000) {
  const deadline = Date.now() + timeout
  for (;;) {
    let lock
    try { lock = await acquireMutex(name, directory, deadline - Date.now()) } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e
      if (process.platform === 'darwin' || Date.now() >= deadline) throw new Error('Bridge busy: request not accepted; existing requests are preserved. Try again shortly.')
      await new Promise(r => setTimeout(r, 25))
      continue
    }
    try { return await fn() } finally { await new Promise(r => lock.close(r)) }
  }
}
