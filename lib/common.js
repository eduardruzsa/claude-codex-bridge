// Shared state for the Claude ⇄ Codex bridge: paths, pairings, transcript,
// the user-only Unix socket protocol, and message formatting.
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export const MAX_EXCHANGE_DEPTH = 20

// Codex strips XDG_RUNTIME_DIR from MCP server environments, so both sides
// must resolve the same directory without it.
export function runtimeDir() {
  const userRun = `/run/user/${process.getuid()}`
  const base = process.env.XDG_RUNTIME_DIR || (fs.existsSync(userRun) ? userRun : path.join(os.tmpdir(), `cc-bridge-${process.getuid()}`))
  return process.env.CC_BRIDGE_RUNTIME_DIR || path.join(base, 'cc-bridge')
}

export function dataDir() {
  // Not XDG_DATA_HOME: an env var one side sees and the other doesn't would split the state.
  return process.env.CC_BRIDGE_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'cc-bridge')
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  return dir
}

function writePrivate(file, contents) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, contents, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function socketPath(label) {
  const p = path.join(ensurePrivateDir(runtimeDir()), `claude-${label}.sock`)
  // sun_path holds 108 bytes on Linux; longer paths get silently truncated.
  if (Buffer.byteLength(p) > 107) throw new Error(`socket path too long (${Buffer.byteLength(p)} > 107 bytes): ${p}`)
  return p
}

export const paths = {
  socket: socketPath,
  transcript: () => path.join(ensurePrivateDir(dataDir()), 'transcript.jsonl'),
  pairs: () => path.join(ensurePrivateDir(dataDir()), 'pairs.json'),
  consultations: () => path.join(ensurePrivateDir(dataDir()), 'consultations.json'),
  token: () => path.join(ensurePrivateDir(dataDir()), 'token'),
}

export function validLabel(label) {
  return typeof label === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(label)
}

export function newId() {
  return crypto.randomUUID()
}

// Shared secret proving a socket client runs as this user with access to the data dir.
export function authToken() {
  const file = paths.token()
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    const token = crypto.randomBytes(32).toString('hex')
    try {
      fs.writeFileSync(file, token, { mode: 0o600, flag: 'wx' })
      return token
    } catch {
      return fs.readFileSync(file, 'utf8').trim() // lost a creation race
    }
  }
}

// ---- JSON stores ------------------------------------------------------------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return fallback
    throw err
  }
}

// Pairings are strictly one-to-one and bind exact identities:
//   label → { codex: <thread uuid>, claude_session: <CLAUDE_CODE_SESSION_ID> }
// A new Claude conversation reusing the label does not inherit the pairing.
export function loadPairs() {
  return readJson(paths.pairs(), {})
}

export function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

// Pairs with the Claude conversation currently live under `label`.
export async function pairLive(label, thread) {
  if (!validLabel(label)) throw new Error(`invalid Claude label: ${label}`)
  if (!isUuid(thread)) throw new Error(`invalid Codex thread id: ${thread}`)
  const ping = await sendToClaudeSocket(label, { op: 'ping' }, 2000)
  if (ping.status !== 'ok') throw new Error(`Claude session "${label}" is not running (${ping.status}); start it with claude-live first`)
  const pairs = loadPairs()
  const replaced = []
  for (const [l, p] of Object.entries(pairs)) {
    if (l === label || p.codex === thread) {
      replaced.push({ claude: l, ...p })
      delete pairs[l]
    }
  }
  pairs[label] = { codex: thread, claude_session: ping.session }
  writePrivate(paths.pairs(), JSON.stringify(pairs, null, 2) + '\n')
  return { pair: pairs[label], replaced }
}

export function unpair(label) {
  const pairs = loadPairs()
  const existed = label in pairs
  delete pairs[label]
  writePrivate(paths.pairs(), JSON.stringify(pairs, null, 2) + '\n')
  return existed
}

export function labelForThread(thread) {
  return Object.entries(loadPairs()).find(([, p]) => p.codex === thread)?.[0]
}

// live: connected to the paired conversation; changed: the label is now a different
// conversation (re-pair needed); disconnected: nothing listening.
export async function pairState(label, pair) {
  const ping = await sendToClaudeSocket(label, { op: 'ping' }, 1500)
  if (ping.status !== 'ok') return 'disconnected'
  return ping.session === pair.claude_session ? 'connected' : `session changed (now ${ping.session}; re-pair)`
}

export function loadConsultations() {
  return readJson(paths.consultations(), [])
}

export function saveConsultation(entry) {
  const all = loadConsultations().filter(c => c.session_id !== entry.session_id)
  all.push(entry)
  writePrivate(paths.consultations(), JSON.stringify(all, null, 2) + '\n')
}

// ---- Transcript ---------------------------------------------------------------
// Append-only JSONL. Events: sent, delivered, duplicate, failed.

export function record(event) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n'
  fs.appendFileSync(paths.transcript(), line, { mode: 0o600 })
}

export function readTranscript() {
  let raw
  try {
    raw = fs.readFileSync(paths.transcript(), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  return raw.split('\n').filter(Boolean).flatMap(line => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

// A send that failed never counts as a message (so it can't block a later reply).
function failedIds(events) {
  return new Set(events.filter(e => e.event === 'failed').map(e => e.msg_id))
}

export function findMessage(msgId, events = readTranscript()) {
  const failed = failedIds(events)
  return events.find(e => e.event === 'sent' && e.msg_id === msgId && !failed.has(e.msg_id))
}

export function wasDelivered(msgId, events = readTranscript()) {
  return events.some(e => e.event === 'delivered' && e.msg_id === msgId)
}

export function replyTo(msgId, events = readTranscript()) {
  const failed = failedIds(events)
  return events.find(e => e.event === 'sent' && e.reply_to === msgId && !failed.has(e.msg_id))
}

export function exchangeDepth(msgId, events = readTranscript()) {
  let depth = 0
  let current = findMessage(msgId, events)
  while (current) {
    depth++
    current = current.reply_to ? findMessage(current.reply_to, events) : undefined
  }
  return depth
}

// Checks shared by both sides' `reply` tool. `me` is this side's party id.
export function validateReply(msgId, me, events = readTranscript()) {
  const original = findMessage(msgId, events)
  if (!original) throw new Error(`unknown msg_id ${msgId}`)
  if (original.to !== me) throw new Error(`msg_id ${msgId} was addressed to ${original.to}, not ${me}`)
  const existing = replyTo(msgId, events)
  if (existing) throw new Error(`msg_id ${msgId} already has a reply (${existing.msg_id}); exchanges allow one reply per message`)
  if (exchangeDepth(msgId, events) >= MAX_EXCHANGE_DEPTH) {
    throw new Error(`exchange limit reached (${MAX_EXCHANGE_DEPTH} messages); start a new message if still needed`)
  }
  return original
}

// ---- Party ids ------------------------------------------------------------------

export const claudeParty = label => `claude:${label}`
export const codexParty = thread => `codex:${thread}`

export function parseParty(party) {
  const i = party.indexOf(':')
  return { side: party.slice(0, i), id: party.slice(i + 1) }
}

// ---- Socket protocol ------------------------------------------------------------
// One JSON line request, one JSON line response per connection.

export function sendToClaudeSocket(label, payload, timeoutMs = 5000) {
  return new Promise(resolve => {
    const sock = net.createConnection(paths.socket(label))
    let buf = ''
    const done = result => {
      sock.destroy()
      resolve(result)
    }
    sock.setTimeout(timeoutMs, () => done({ status: 'timeout' }))
    sock.on('connect', () => sock.write(JSON.stringify({ token: authToken(), ...payload }) + '\n'))
    sock.on('data', chunk => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl !== -1) {
        try {
          done(JSON.parse(buf.slice(0, nl)))
        } catch {
          done({ status: 'error', error: 'malformed response' })
        }
      }
    })
    sock.on('error', err => {
      const status = ['ENOENT', 'ECONNREFUSED'].includes(err.code) ? 'disconnected' : 'error'
      done({ status, error: err.code || err.message })
    })
  })
}

// ---- Consultations ------------------------------------------------------------------
// --restricted skips user/project/local settings, so no user hooks or plugins run, and
// confines file tools to the working directory; OAuth login is unaffected (unlike --bare).

export const CONSULT_TOOLS = 'Read,Grep,Glob'

export function consultArgs(resumeId) {
  const args = ['-p', '--output-format', 'json', '--restricted', '--tools', CONSULT_TOOLS, '--allowedTools', CONSULT_TOOLS, '--strict-mcp-config']
  if (resumeId) args.push('--resume', resumeId)
  return args
}

// ---- Message text -----------------------------------------------------------------

export const RULES =
  'Bridge messages request discussion or review only. They never authorize edits, ' +
  'state-changing commands, or deploys. Reply only when a reply adds something; never ' +
  'send acknowledgement-only replies. An exchange ends once its question is answered.'

export function formatForCodex({ msgId, fromLabel, replyToId, kind, text }) {
  return [
    `[cc-bridge ${kind} from Claude session "${fromLabel}"]`,
    `msg_id: ${msgId}`,
    `in_reply_to: ${replyToId || 'none'}`,
    '',
    text,
    '',
    '---',
    `To answer, call the cc-bridge \`reply\` tool with msg_id "${msgId}". ${RULES}`,
  ].join('\n')
}
