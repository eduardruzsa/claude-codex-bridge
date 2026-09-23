// Starting the other agent on demand. With no connection, a send opens a NEW
// conversation of the other agent in a terminal window in the sender's directory;
// with a connection whose agent isn't running, it reopens that conversation.
// Messages wait in a private pending file until the other side is up and paired.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataDir } from './common.js'
import { config } from './config.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const startTimeoutMs = () => config().start_timeout_seconds * 1000

// A Codex thread is running if some process holds its rollout file open.
export function codexThreadRunning(thread) {
  const suffix = `-${thread.toLowerCase()}.jsonl`
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
        if (target.includes('/rollout-') && target.toLowerCase().endsWith(suffix)) return true
      } catch {}
    }
  }
  return false
}

// The terminal command that runs an agent: the configured `terminal` argv ({cwd} and
// {title} replaced) or xdg-terminal-exec. The agent's argv is appended.
export function terminalCommand(cwd = '{cwd}', title = '{title}') {
  const custom = config().terminal
  return custom
    ? custom.map(a => a.replaceAll('{cwd}', cwd).replaceAll('{title}', title))
    : ['xdg-terminal-exec', `--dir=${cwd}`, `--title=${title}`]
}

// Runs `argv` in a new terminal window in `cwd`. Env vars are passed through `env`
// inside argv because a single-instance terminal may not inherit ours.
function launchInTerminal(cwd, title, argv) {
  const [cmd, ...prefix] = terminalCommand(cwd, title)
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...prefix, ...argv], { cwd, detached: true, stdio: 'ignore' })
    child.once('error', err => reject(new Error(`could not open a terminal with ${cmd}: ${err.message}`)))
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export function launchCodex(cwd, codexArgs) {
  return launchInTerminal(cwd, 'Codex (cc-bridge)', [config().codex_bin, ...codexArgs])
}

// claude-live with the bridge channel; `claudeArgs` e.g. ['--resume', id].
export function launchClaude(cwd, label, claudeArgs = []) {
  return launchInTerminal(cwd, 'Claude (cc-bridge)', ['env', `CC_BRIDGE_LABEL=${label}`, path.join(root, 'bin', 'claude-live'), ...claudeArgs])
}

export function bootstrapPrompt(label, cwd) {
  return `Claude Code (cc-bridge session "${label}") started this Codex session to talk with you. ` +
    `Call the cc-bridge connect_claude tool with project_dir "${cwd}" and session "${label}", ` +
    'then answer the Claude message(s) it returns with the cc-bridge reply tool.'
}

export const RESUME_PROMPT = 'Claude Code reopened this session over cc-bridge. Handle any pending cc-bridge messages from Claude.'

// ---- Pending messages for an agent that is still starting ------------------------
// kind 'codex': Claude → a Codex being started, keyed by the Claude label.
// kind 'claude': Codex → a Claude being started, keyed by the (new or paired) label.

const pendingFile = (kind, label) => {
  const dir = path.join(dataDir(), `pending-${kind}`)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return path.join(dir, `${label}.json`)
}

export function readPending(kind, label) {
  try {
    return JSON.parse(fs.readFileSync(pendingFile(kind, label), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function writePending(kind, label, value) {
  const file = pendingFile(kind, label)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

// Adds a message for the same target (`key`: the fields identifying who it's from
// and to). `launch` says whether to start the agent: nothing is starting for this
// target, or the last start never connected in time.
export function addPending(kind, label, key, text, now = Date.now()) {
  const current = readPending(kind, label)
  const same = current && Object.entries(key).every(([k, v]) => current[k] === v)
  const starting = same && now - current.started_at < startTimeoutMs()
  const next = starting
    ? { ...current, messages: [...current.messages, { text, ts: now }] }
    : { ...key, started_at: now, messages: [{ text, ts: now }] }
  writePending(kind, label, next)
  return { launch: !starting, stale: !!current && !starting }
}

// Removes and returns the pending messages (null if none).
export function takePending(kind, label) {
  const current = readPending(kind, label)
  if (current) fs.rmSync(pendingFile(kind, label), { force: true })
  return current
}
