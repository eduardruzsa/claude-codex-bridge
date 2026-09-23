#!/usr/bin/env node
// Runs INSIDE the terminal. Its PID remains distinct from the terminal launcher.
import { spawn } from 'node:child_process'
import { readLaunch, updateLaunch } from '../lib/launch-state.js'
import { codexThreadRunning } from '../lib/launch.js'
import { processIdentity } from '../lib/store.js'

const id = process.argv[2]
if (process.argv[3]) process.env.CC_BRIDGE_DATA_DIR = process.argv[3]
if (process.argv[4]) process.env.CC_BRIDGE_RUNTIME_DIR = process.argv[4]
if (process.argv[5]) process.env.CC_BRIDGE_CONFIG = process.argv[5]
const launch = readLaunch(id)
if (!launch || launch.state === 'superseded') process.exit(0)
if (!(await updateLaunch(id, { state: 'running', owner: processIdentity() }))) process.exit(0)
const child = spawn(launch.argv[0], launch.argv.slice(1), {
  cwd: launch.cwd, stdio: 'inherit', env: { ...process.env, CC_BRIDGE_LAUNCH_ID: id },
})
let ended = false
let connected = false, probing = false
const probe = setInterval(async () => {
  if (probing || connected || ended || launch.kind !== 'codex' || !launch.codex) return
  probing = true
  try {
    if (codexThreadRunning(launch.codex)) {
      await updateLaunch(id, { connected: launch.codex }); connected = true
    }
  } catch (err) { console.error(`cc-bridge: startup tracking: ${err.message}`) }
  finally { probing = false }
}, 500)
probe.unref()
async function finish(patch) {
  if (ended) return
  ended = true
  clearInterval(probe)
  await updateLaunch(id, { ...patch, ended_at: new Date().toISOString() })
}
child.once('spawn', () => updateLaunch(id, { agent: processIdentity(child.pid) }).catch(e => console.error(e.message)))
child.once('error', async err => { await finish({ state: 'failed', error: err.message }); process.exitCode = 1 })
child.once('exit', async (code, signal) => {
  await finish({ state: 'exited', exit_code: code, signal })
  process.exitCode = code ?? 1
})
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))
