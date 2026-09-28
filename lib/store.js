// Cross-process locks are kernel-owned: a crashed writer cannot leave a stale lock.
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { dataDir } from './common.js'
import { processInfo, withMutex } from './platform.js'

export async function withStoreLock(key, fn, timeout = 3000) {
  const name = '\0ccb-store-' + crypto.createHash('sha256').update(`${dataDir()}:${key}`).digest('hex').slice(0, 40)
  return withMutex(name, path.join(dataDir(), 'locks'), fn, timeout)
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
  const p = processInfo(pid)
  return p ? { pid: p.pid, start: p.start, parent: p.parent, state: p.state } : null
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
