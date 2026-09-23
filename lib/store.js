// Cross-process locks are kernel-owned: a crashed writer cannot leave a stale lock.
import fs from 'node:fs'
import net from 'node:net'
import crypto from 'node:crypto'
import path from 'node:path'
import { dataDir } from './common.js'

export async function withStoreLock(key, fn, timeout = 3000) {
  const name = '\0ccb-store-' + crypto.createHash('sha256').update(`${dataDir()}:${key}`).digest('hex').slice(0, 40)
  const deadline = Date.now() + timeout
  for (;;) {
    const lock = net.createServer(c => c.destroy())
    try {
      await new Promise((resolve, reject) => { lock.once('error', reject); lock.listen(name, resolve) })
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e
      if (Date.now() >= deadline) throw new Error('Bridge busy: request not accepted; existing requests are preserved. Try again shortly.')
      await new Promise(r => setTimeout(r, 25))
      continue
    }
    try { return await fn() } finally { await new Promise(r => lock.close(r)) }
  }
}
export function readStore(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return fallback; throw e }
}
export function writeStore(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}
export function processIdentity(pid = process.pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = s.slice(s.lastIndexOf(')') + 2).split(' ')
    return { pid: Number(pid), start: fields[19], parent: Number(fields[1]), state: fields[0] }
  } catch { return null }
}
export function processAlive(owner) {
  const p = owner && processIdentity(owner.pid)
  return !!p && p.start === owner.start && !['Z', 'X'].includes(p.state)
}
export function isAncestor(owner, pid = process.pid) {
  if (!processAlive(owner)) return false
  for (let n = 0; pid > 1 && n < 100; n++) {
    const p = processIdentity(pid)
    if (!p) return false
    if (p.pid === owner.pid && p.start === owner.start) return true
    pid = p.parent
  }
  return false
}
