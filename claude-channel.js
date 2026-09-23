#!/usr/bin/env node
// Claude Code side of the bridge: a two-way Claude Channel, shipped as the cc-bridge
// plugin's MCP server. It loads in every Claude session but stays dormant (no tools,
// no socket) unless Claude was started with the channel (bin/claude-live). Codex
// messages arrive on a user-only Unix socket and are pushed into the session as
// <channel source="cc-bridge" ...> events.
import fs from 'node:fs'
import net from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  RULES,
  authToken,
  labelMutexName,
  claudeParty,
  codexParty,
  loadPairs,
  newId,
  pairLive,
  parseParty,
  paths,
  readTranscript,
  record,
  validLabel,
  validateReply,
  wasDelivered,
} from './lib/common.js'
import { deliverToCodex } from './lib/deliver.js'
import { identity } from './lib/lifecycle.js'
import { channelActive, findClaudeProcess, launchedWithChannel, lifecycleDirFor, sweepLifecycleDirs } from './lib/claude-process.js'
import { RESUME_PROMPT, START_TIMEOUT_MS, addPending, bootstrapPrompt, codexThreadRunning, launchCodex, readPending, takePending } from './lib/launch.js'

const label = process.env.CC_BRIDGE_LABEL || 'claude'
if (!validLabel(label)) {
  console.error(`cc-bridge: invalid CC_BRIDGE_LABEL "${label}"`)
  process.exit(1)
}
const me = claudeParty(label)
const claudeProc = findClaudeProcess()
const active = channelActive(claudeProc)
// Plugin mode: the SessionStart/SessionEnd hooks keep this Claude process's
// conversation id in a per-process directory. Adopt it once the hook created it.
const pluginLifecycleDir = !process.env.CC_BRIDGE_LIFECYCLE_DIR && claudeProc && launchedWithChannel(claudeProc.args)
  ? lifecycleDirFor(claudeProc)
  : null
function currentIdentity() {
  if (pluginLifecycleDir && !process.env.CC_BRIDGE_LIFECYCLE_DIR && fs.existsSync(pluginLifecycleDir)) {
    process.env.CC_BRIDGE_LIFECYCLE_DIR = pluginLifecycleDir
  }
  return identity()
}
// The real Claude conversation id; pairings bind to it, not just to the label.
function currentSession() {
  const state = currentIdentity()
  if (!state.ready || !state.session) throw new Error('Claude conversation is transitioning or unavailable; wait for SessionStart or restart claude-live')
  return state.session
}
let listening = false
let listenError = null

const mcp = new Server(
  { name: 'cc-bridge', version: '0.1.0' },
  {
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions: !active ? 'cc-bridge is inactive in this session. To talk with Codex, restart Claude with claude-live.' :
      `This session is bridged to a Codex session as Claude session "${label}". ` +
      'Codex messages arrive as <channel source="cc-bridge" msg_id="..." from="codex:<thread>" kind="message|reply" in_reply_to="...">. ' +
      'To answer one, call the `reply` tool with its msg_id. To start a new exchange with Codex, call `send_to_codex`; ' +
      'if no Codex is running it opens a new Codex session in a terminal in this directory. ' +
      'Your ordinary terminal output is NOT forwarded to Codex; only these tools send anything. ' +
      `${RULES} Sends are asynchronous: a queued status means delivered to Codex, not answered; answers arrive later as new channel events.`,
  },
)

const TOOLS = [
  {
    name: 'send_to_codex',
    description: `Start a new exchange with Codex. Uses the paired Codex session; if it isn't running, reopens it in a new terminal, and if there is none, starts a new Codex session in a terminal in this directory. Returns immediately; Codex's answer arrives later as a channel event. ${RULES}`,
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The question or message for Codex' } },
      required: ['text'],
    },
  },
  {
    name: 'reply',
    description: 'Answer a Codex message received over the cc-bridge channel. Each message accepts one reply; to follow up on a Codex reply, reply to that reply\'s msg_id.',
    inputSchema: {
      type: 'object',
      properties: {
        msg_id: { type: 'string', description: 'msg_id attribute of the <channel> event being answered' },
        text: { type: 'string' },
      },
      required: ['msg_id', 'text'],
    },
  },
  {
    name: 'bridge_status',
    description: 'Show this session\'s bridge label, its paired Codex thread, and recent messages.',
    inputSchema: { type: 'object', properties: {} },
  },
]

const text = t => ({ content: [{ type: 'text', text: t }] })
const fail = t => ({ content: [{ type: 'text', text: t }], isError: true })

// The pairing for this label, only if it belongs to this exact conversation.
function myPair() {
  const mySession = currentSession()
  const pair = loadPairs()[label]
  if (!pair) throw new Error(`Claude session "${label}" is not paired with a Codex thread. Pair it with: cc-bridge pair --claude ${label} --codex <thread-uuid>`)
  if (pair.claude_session !== mySession) {
    throw new Error(`the "${label}" pairing belongs to Claude conversation ${pair.claude_session}, not this one (${mySession}); re-pair to use it here`)
  }
  return pair
}

async function sendToPairedCodex(body, replyToId, kind) {
  if (!listening) return fail(`bridge is not listening: ${listenError}`)
  const thread = myPair().codex
  const mySession = currentSession()
  const res = await deliverToCodex({ fromLabel: label, claudeSession: mySession, thread, text: body, replyToId, kind })
  if (res.status !== 'queued') return fail(`not delivered to Codex thread ${thread}: ${res.error} (msg_id ${res.msg_id}; not retried)`)
  return text(`queued for Codex thread ${thread} (msg_id ${res.msg_id}). Its answer, if any, arrives later as a channel event.`)
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: active ? TOOLS : [] }))

// send_to_codex, starting or reopening Codex when needed. Serialized so two quick
// sends can't open two Codex windows.
let sendChain = Promise.resolve()
const resuming = new Map() // Codex thread → when we opened a terminal to resume it
function sendNewToCodex(body) {
  const run = sendChain.then(() => sendNew(body))
  sendChain = run.catch(() => {})
  return run
}

async function sendNew(body) {
  if (!listening) return fail(`bridge is not listening: ${listenError}`)
  const mySession = currentSession()
  const cwd = currentIdentity().cwd || process.cwd()
  const pair = loadPairs()[label]
  if (pair && pair.claude_session === mySession) {
    if (codexThreadRunning(pair.codex)) return sendToPairedCodex(body, null, 'message')
    const res = await deliverToCodex({ fromLabel: label, claudeSession: mySession, thread: pair.codex, text: body, kind: 'message' })
    if (res.status !== 'queued') return fail(`not delivered to Codex thread ${pair.codex}: ${res.error} (msg_id ${res.msg_id}; not retried)`)
    // Codex takes a while to open its rollout; don't open a second terminal meanwhile.
    const opening = Date.now() - (resuming.get(pair.codex) || 0) < START_TIMEOUT_MS
    if (!opening) {
      await launchCodex(cwd, ['resume', pair.codex, RESUME_PROMPT])
      resuming.set(pair.codex, Date.now())
    }
    return text(`Codex thread ${pair.codex} wasn't running, so it ${opening ? 'is already reopening' : 'was reopened in a new terminal'} in ${cwd}. ` +
      `Message queued (msg_id ${res.msg_id}); the answer arrives later as a channel event.`)
  }
  const { launch, stale } = addPending('codex', label, { claude_session: mySession, cwd }, body)
  if (!launch) return text('A Codex session is already starting for this conversation; the message will be delivered when it connects.')
  try {
    await launchCodex(cwd, [bootstrapPrompt(label, cwd)])
  } catch (err) {
    takePending('codex', label)
    return fail(`${err.message}. Start Codex yourself in ${cwd} and ask it to connect_claude with session "${label}".`)
  }
  return text(`No Codex session was ${pair ? 'paired with this conversation' : 'running for this session'}; started a new Codex session in a terminal in ${cwd}` +
    (stale ? ' (an earlier start never connected)' : '') +
    `. Your message is delivered once it connects${pair ? `, replacing the pairing with thread ${pair.codex}` : ''}; approve its cc-bridge tool calls there. The answer arrives later as a channel event.`)
}

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = req.params.arguments || {}
  try {
    switch (req.params.name) {
      case 'send_to_codex':
        return await sendNewToCodex(String(args.text || ''))
      case 'reply': {
        const mySession = currentSession()
        const original = validateReply(String(args.msg_id), me, mySession)
        if (parseParty(original.from).side !== 'codex') return fail(`msg_id ${args.msg_id} did not come from Codex`)
        const paired = myPair().codex
        const origThread = parseParty(original.from).id
        if (paired !== origThread) return fail(`msg_id ${args.msg_id} came from Codex thread ${origThread}, but this session is now paired with ${paired}; not rerouting`)
        return await sendToPairedCodex(String(args.text || ''), original.msg_id, 'reply')
      }
      case 'bridge_status': {
        const mySession = currentIdentity().ready ? currentIdentity().session : 'transitioning/unavailable'
        const recent = readTranscript()
          .filter(e => e.event === 'sent' && (e.from === me || e.to === me))
          .slice(-10)
          .map(e => `${e.ts} ${e.kind} ${e.from} → ${e.to} msg_id=${e.msg_id}${e.reply_to ? ` in_reply_to=${e.reply_to}` : ''}`)
        return text([
          `label: ${label} (${listening ? 'listening' : `NOT listening: ${listenError}`})`,
          `this conversation: ${mySession}`,
          `pairing: ${(() => {
            const p = loadPairs()[label]
            if (!p) return 'none'
            return p.claude_session === mySession ? `Codex thread ${p.codex}` : `belongs to another conversation (${p.claude_session}); re-pair`
          })()}`,
          'recent:',
          ...(recent.length ? recent : ['  (none)']),
        ].join('\n'))
      }
      default:
        return fail(`unknown tool: ${req.params.name}`)
    }
  } catch (err) {
    return fail(err.message)
  }
})

// ---- Inbound socket ----------------------------------------------------------------

const claimed = new Set() // msg_ids accepted by this process, including in-flight ones

async function handleRequest(req) {
  if (req.token !== authToken()) return { status: 'error', error: 'unauthorized' }
  const state = currentIdentity()
  if (req.op === 'ping') return { status: state.ready ? 'ok' : 'transitioning', label, session: state.session, cwd: state.cwd, lifecycle: state.lifecycle }
  const mySession = currentSession()
  if (req.op !== 'deliver') return { status: 'error', error: `unknown op ${req.op}` }
  if (req.to !== me) return { status: 'error', error: `this is ${me}, not ${req.to}` }
  if (req.claude_session !== mySession) {
    return { status: 'session_changed', error: `label "${label}" is now Claude conversation ${mySession}, not the paired ${req.claude_session}; re-pair` }
  }
  if (parseParty(req.from).side !== 'codex') return { status: 'error', error: 'sender must be a Codex thread' }
  // Reserve the id synchronously, before any await, so concurrent duplicates can't both pass.
  if (claimed.has(req.msg_id) || wasDelivered(req.msg_id)) {
    record({ event: 'duplicate', msg_id: req.msg_id })
    return { status: 'duplicate' }
  }
  claimed.add(req.msg_id)
  try {
    await pushToClaude(req)
  } catch (err) {
    claimed.delete(req.msg_id)
    throw err
  }
  record({ event: 'delivered', msg_id: req.msg_id })
  return { status: 'delivered' }
}

// Messages Codex left while it was starting or reopening this Claude conversation.
// A new conversation (claude_session null) first pairs with that Codex thread.
async function adoptPendingFromCodex() {
  const pending = readPending('claude', label)
  if (!pending) return true
  const state = currentIdentity()
  if (!state.ready || !state.session) return false // wait for SessionStart
  takePending('claude', label)
  if (pending.claude_session && pending.claude_session !== state.session) {
    record({ event: 'dropped', label, reason: `pending messages were for Claude conversation ${pending.claude_session}` })
    return true
  }
  if (!pending.claude_session) await pairLive(label, pending.codex)
  const pair = loadPairs()[label]
  if (pair?.codex !== pending.codex || pair.claude_session !== state.session) {
    record({ event: 'dropped', label, reason: 'pairing changed before pending messages were delivered' })
    return true
  }
  for (const m of pending.messages) {
    const msg = { msg_id: newId(), from: codexParty(pending.codex), to: me, claude_session: state.session, reply_to: null, kind: 'message', text: m.text }
    record({ event: 'sent', ...msg })
    claimed.add(msg.msg_id)
    await pushToClaude(msg)
    record({ event: 'delivered', msg_id: msg.msg_id })
  }
  return true
}

function watchPendingFromCodex() {
  const deadline = Date.now() + 2 * 60 * 1000
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      if ((await adoptPendingFromCodex()) || Date.now() > deadline) clearInterval(timer)
    } catch (err) {
      console.error(`cc-bridge: pending delivery failed: ${err.message}`)
      clearInterval(timer)
    } finally {
      busy = false
    }
  }
  const timer = setInterval(tick, 500)
  timer.unref()
  tick()
}

function pushToClaude(req) {
  return mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: String(req.text),
      meta: {
        msg_id: req.msg_id,
        from: req.from,
        kind: req.kind === 'reply' ? 'reply' : 'message',
        in_reply_to: req.reply_to || 'none',
      },
    },
  })
}

function serve(conn) {
  let buf = ''
  let handled = false // one request per connection; later bytes are ignored
  conn.setEncoding('utf8')
  conn.on('data', async chunk => {
    if (handled) return
    buf += chunk
    const nl = buf.indexOf('\n')
    if (nl === -1) {
      if (buf.length > 1_000_000) conn.destroy()
      return
    }
    handled = true
    let res
    try {
      res = await handleRequest(JSON.parse(buf.slice(0, nl)))
    } catch (err) {
      res = { status: 'error', error: err.message }
    }
    conn.end(JSON.stringify(res) + '\n')
  })
  conn.on('error', () => {})
}

// Exclusive ownership of the label: a Linux abstract-namespace socket bound only as a
// mutex (name from labelMutexName). The kernel allows one binder and releases it when
// the process dies, so there is no stale lock to recover and no read-then-delete race.
function acquireLabel() {
  const mutex = net.createServer(c => c.destroy())
  return new Promise((resolve, reject) => {
    mutex.once('error', err =>
      reject(err.code === 'EADDRINUSE'
        ? new Error(`another live Claude session already uses label "${label}"; set CC_BRIDGE_LABEL to a different name`)
        : err))
    mutex.listen(labelMutexName(label), () => resolve(mutex))
  })
}

// An existing socket file is removed only when provably dead (nothing accepts on it).
// This also covers an owner the mutex can't see, e.g. one in another network namespace.
function socketIsDead(sockPath) {
  return new Promise(resolve => {
    const probe = net.createConnection(sockPath)
    probe.setTimeout(1000, () => {
      probe.destroy()
      resolve(false) // slow is not dead
    })
    probe.on('connect', () => {
      probe.destroy()
      resolve(false)
    })
    probe.on('error', err => resolve(['ENOENT', 'ECONNREFUSED'].includes(err.code)))
  })
}

async function listen() {
  if (!process.env.CC_BRIDGE_LIFECYCLE_DIR && !pluginLifecycleDir && !currentIdentity().ready) throw new Error('CLAUDE_CODE_SESSION_ID is not set; launch through claude-live')
  const sockPath = paths.socket(label)
  const mutex = await acquireLabel()
  try {
    if (fs.existsSync(sockPath)) {
      if (!(await socketIsDead(sockPath))) throw new Error(`a live process is still serving ${sockPath}; not replacing it`)
      fs.unlinkSync(sockPath)
    }
    const server = net.createServer(serve)
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(sockPath, resolve)
    })
  } catch (err) {
    mutex.close() // don't keep the label while not listening
    throw err
  }
  fs.chmodSync(sockPath, 0o600)
  const { ino, dev } = fs.statSync(sockPath)
  process.on('exit', () => {
    try {
      const st = fs.statSync(sockPath)
      if (st.ino === ino && st.dev === dev) fs.unlinkSync(sockPath) // only our own socket
    } catch {}
  })
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0))
  process.stdin.on('close', () => process.exit(0))
}

await mcp.connect(new StdioServerTransport())
if (!active) {
  // Dormant: this Claude session wasn't started with the channel.
  process.stdin.on('close', () => process.exit(0))
} else try {
  // Lifecycle state belongs to the Claude process, not to this server: a restarted
  // server in the same conversation needs it (no new SessionStart would restore it).
  // State of Claude processes that have ended is swept here instead.
  if (pluginLifecycleDir) sweepLifecycleDirs()
  await listen()
  listening = true
  watchPendingFromCodex()
} catch (err) {
  listenError = err.message
  console.error(`cc-bridge: ${err.message}`)
}
