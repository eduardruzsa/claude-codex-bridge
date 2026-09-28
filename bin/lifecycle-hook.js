#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { macHelper, withMutex } from '../lib/platform.js'
import { authToken, runtimeDir } from '../lib/common.js'
import { updateState } from '../lib/lifecycle.js'
import { channelActive, findClaudeProcess, lifecycleDirFor } from '../lib/claude-process.js'

const order = process.hrtime.bigint().toString()
let [dir] = process.argv.slice(2)
const input = fs.readFileSync(0, 'utf8')
if (dir === '--plugin') {
  // Without the helper Claude can't be identified here or by the channel server,
  // which then stays dormant. Say why instead of exiting silently; never block.
  if (process.platform === 'darwin') try { macHelper() } catch (e) { console.error(`cc-bridge lifecycle: ${e.message}`); process.exit(0) }
  // Plugin hooks run in every Claude session; only channel sessions keep state.
  const proc = findClaudeProcess()
  if (!proc || !channelActive(proc)) process.exit(0)
  dir = lifecycleDirFor(proc)
  const event = JSON.parse(input).hook_event_name
  if (event === 'SessionStart') fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  else if (!fs.existsSync(dir)) process.exit(0)
}
try {
  if (!path.isAbsolute(dir) || !fs.statSync(dir).isDirectory()) throw new Error('missing launcher state')
  // The kernel releases this lock even if a hook is killed. Keyed with the private
  // token so other local users can't compute the name and block the hook.
  const key = crypto.createHmac('sha256', authToken()).update(dir).digest('hex').slice(0, 32)
  await withMutex(`\0cc-bridge-lifecycle-${key}`, path.join(runtimeDir(), 'locks'), () => updateState(dir, JSON.parse(input), order), 2000)
} catch (err) {
  // Fail closed if identity cannot be updated; the channel sees invalid JSON.
  try { fs.writeFileSync(path.join(dir, 'state.json'), '', { mode: 0o600 }) } catch {}
  console.error(`cc-bridge lifecycle: ${err.message}`)
  process.exitCode = 1
}
