// Starting the other agent on demand. With no connection, a send opens a NEW
// conversation of the other agent in a terminal window in the sender's directory;
// with a connection whose agent isn't running, it reopens that conversation.
// Requests wait in private pending storage; durable launch reservations prevent duplicate windows.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataDir, runtimeDir } from './common.js'
import { config, configPath } from './config.js'
import { reserveLaunch, updateLaunch } from './launch-state.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const startTimeoutMs = () => config().start_timeout_seconds * 1000

// A Codex thread is running if some process holds its rollout file open.
export function runningCodexThreads() {
  const threads = new Set()
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    let fds
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      try {
        const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`)
        const match = target.match(/\/rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
        if (match) threads.add(match[1].toLowerCase())
      } catch {}
    }
  }
  return threads
}
export const codexThreadRunning = thread => runningCodexThreads().has(thread.toLowerCase())

// The terminal command that runs an agent: the configured `terminal` argv ({cwd} and
// {title} replaced) or xdg-terminal-exec. The agent's argv is appended.
export function terminalCommand(cwd = '{cwd}', title = '{title}') {
  const custom = config().terminal
  return custom
    ? custom.map(a => a.replaceAll('{cwd}', cwd).replaceAll('{title}', title))
    : ['xdg-terminal-exec', `--dir=${cwd}`, `--title=${title}`]
}

// The environment for an agent we start: the user's, minus the session of the agent
// that is starting it. Claude Code gives its MCP servers CLAUDE_PROJECT_DIR, session
// ids and a messaging token; a Codex inheriting them runs its hooks as if under Claude
// (and holds the token). Settings the user chose (CLAUDE_CONFIG_DIR, CODEX_HOME) stay.
const KEEP = new Set(['CLAUDE_CONFIG_DIR', 'CODEX_HOME'])
export function agentEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) =>
    KEEP.has(k) || !/^(CLAUDE|CODEX_|CC_BRIDGE_(LABEL|LIFECYCLE_DIR|LAUNCH_ID)$)/.test(k)))
}

// Runs `argv` in a new terminal window in `cwd`. Env vars are passed through `env`
// inside argv because a single-instance terminal may not inherit ours.
export function launchInTerminal(cwd, title, argv, onFailure = () => {}) {
  const [cmd, ...prefix] = terminalCommand(cwd, title)
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...prefix, ...argv], { cwd, env: agentEnv(), detached: true, stdio: 'ignore' })
    child.once('error', err => reject(new Error(`could not open a terminal with ${cmd}: ${err.message}`)))
    child.once('exit', (code, signal) => {
      if (code !== 0) Promise.resolve(onFailure(`Terminal launcher exited ${code ?? signal}`)).catch(err => console.error(`cc-bridge: ${err.message}`))
    })
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

async function launchAgent(spec, title, retry = false) {
  const { launch, fresh } = await reserveLaunch(spec, retry)
  if (!fresh) return { launch, fresh }
  try {
    await launchInTerminal(spec.cwd, title, [process.execPath, path.join(root, 'bin/agent-launch.js'), launch.id, dataDir(), runtimeDir(), configPath()], error => updateLaunch(launch.id, current => current.state === 'starting' && !current.owner ? { state: 'failed', error } : null))
  } catch (err) {
    await updateLaunch(launch.id, { state: 'failed', error: err.message })
    throw err
  }
  return { launch, fresh }
}
export function launchCodex(cwd, codexArgs, label, claude_session, codex = null, retry = false, generation) {
  return launchAgent({ kind: 'codex', label, claude_session, codex, cwd, generation, argv: [config().codex_bin, ...codexArgs] }, 'Codex (cc-bridge)', retry)
}
export function launchClaude(cwd, label, claudeArgs = [], codex = null, retry = false, generation) {
  const claude_session = claudeArgs[0] === '--resume' ? claudeArgs[1] : null
  return launchAgent({ kind: 'claude', label, claude_session, codex, cwd, generation,
    argv: ['env', `CC_BRIDGE_LABEL=${label}`, path.join(root, 'bin', 'claude-live'), ...claudeArgs] }, 'Claude (cc-bridge)', retry)
}

export function bootstrapPrompt(label, cwd) {
  return `Claude Code (cc-bridge session "${label}") started this Codex session to talk with you. ` +
    `Call the cc-bridge connect_claude tool with project_dir "${cwd}" and session "${label}", ` +
    'then answer the Claude message(s) it returns with the cc-bridge reply tool.'
}

export const RESUME_PROMPT = 'Claude Code reopened this session over cc-bridge. Handle any pending cc-bridge messages from Claude.'

export { addPending, readPending, claimPending, finishPending } from './pending.js'
