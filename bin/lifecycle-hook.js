#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { updateState } from '../lib/lifecycle.js'
import { channelActive, findClaudeProcess, lifecycleDirFor } from '../lib/claude-process.js'

const order = process.hrtime.bigint().toString()
let [dir, locked, originalOrder] = process.argv.slice(2)
const input = fs.readFileSync(0, 'utf8')
if (dir === '--plugin') {
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
  if (locked === '--locked') {
    updateState(dir, JSON.parse(input), originalOrder)
  } else {
    // The kernel releases this lock even if a hook is killed. No stale-lock deletion.
    fs.closeSync(fs.openSync(path.join(dir, 'state.lock'), 'a', 0o600))
    execFileSync('flock', ['-w', '2', path.join(dir, 'state.lock'), process.execPath,
      fileURLToPath(import.meta.url), dir, '--locked', order], { input, timeout: 3000, stdio: ['pipe', 'ignore', 'pipe'] })
  }
} catch (err) {
  // Fail closed if identity cannot be updated; the channel sees invalid JSON.
  try { fs.writeFileSync(path.join(dir, 'state.json'), '', { mode: 0o600 }) } catch {}
  console.error(`cc-bridge lifecycle: ${err.message}`)
  process.exitCode = 1
}
