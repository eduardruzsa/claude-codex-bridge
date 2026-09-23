#!/usr/bin/env node
// Claude Code side of the bridge: a two-way Claude Channel.
// Launched by Claude Code over stdio (see bin/claude-live). Codex messages
// arrive on a user-only Unix socket and are pushed into the session as
// <channel source="cc-bridge" ...> events.
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  RULES,
  authToken,
  claudeParty,
  loadPairs,
  parseParty,
  paths,
  readTranscript,
  record,
  validLabel,
  validateReply,
  wasDelivered,
} from './lib/common.js'
import { deliverToCodex } from './lib/deliver.js'

const label = process.env.CC_BRIDGE_LABEL || 'claude'
if (!validLabel(label)) {
  console.error(`cc-bridge: invalid CC_BRIDGE_LABEL "${label}"`)
  process.exit(1)
}
const me = claudeParty(label)
// The real Claude conversation id; pairings bind to it, not just to the label.
const mySession = process.env.CLAUDE_CODE_SESSION_ID || null
let listening = false
let listenError = null

const mcp = new Server(
  { name: 'cc-bridge', version: '0.1.0' },
  {
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions:
      `This session is bridged to a Codex session as Claude session "${label}". ` +
      'Codex messages arrive as <channel source="cc-bridge" msg_id="..." from="codex:<thread>" kind="message|reply" in_reply_to="...">. ' +
      'To answer one, call the `reply` tool with its msg_id. To start a new exchange with Codex, call `send_to_codex`. ' +
      'Your ordinary terminal output is NOT forwarded to Codex; only these tools send anything. ' +
      `${RULES} Sends are asynchronous: a queued status means delivered to Codex, not answered; answers arrive later as new channel events.`,
  },
)

const TOOLS = [
  {
    name: 'send_to_codex',
    description: `Start a new exchange with the paired Codex session. Returns immediately with the delivery status; Codex's answer arrives later as a channel event. ${RULES}`,
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
  const res = await deliverToCodex({ fromLabel: label, claudeSession: mySession, thread, text: body, replyToId, kind })
  if (res.status !== 'queued') return fail(`not delivered to Codex thread ${thread}: ${res.error} (msg_id ${res.msg_id}; not retried)`)
  return text(`queued for Codex thread ${thread} (msg_id ${res.msg_id}). Its answer, if any, arrives later as a channel event.`)
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = req.params.arguments || {}
  try {
    switch (req.params.name) {
      case 'send_to_codex':
        return await sendToPairedCodex(String(args.text || ''), null, 'message')
      case 'reply': {
        const original = validateReply(String(args.msg_id), me)
        if (parseParty(original.from).side !== 'codex') return fail(`msg_id ${args.msg_id} did not come from Codex`)
        if (original.claude_session !== mySession) return fail(`msg_id ${args.msg_id} was addressed to Claude conversation ${original.claude_session}, not this one`)
        const paired = myPair().codex
        const origThread = parseParty(original.from).id
        if (paired !== origThread) return fail(`msg_id ${args.msg_id} came from Codex thread ${origThread}, but this session is now paired with ${paired}; not rerouting`)
        return await sendToPairedCodex(String(args.text || ''), original.msg_id, 'reply')
      }
      case 'bridge_status': {
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

async function handleRequest(req) {
  if (req.token !== authToken()) return { status: 'error', error: 'unauthorized' }
  if (req.op === 'ping') return { status: 'ok', label, session: mySession }
  if (req.op !== 'deliver') return { status: 'error', error: `unknown op ${req.op}` }
  if (req.to !== me) return { status: 'error', error: `this is ${me}, not ${req.to}` }
  if (req.claude_session !== mySession) {
    return { status: 'session_changed', error: `label "${label}" is now Claude conversation ${mySession}, not the paired ${req.claude_session}; re-pair` }
  }
  if (parseParty(req.from).side !== 'codex') return { status: 'error', error: 'sender must be a Codex thread' }
  if (wasDelivered(req.msg_id)) {
    record({ event: 'duplicate', msg_id: req.msg_id })
    return { status: 'duplicate' }
  }
  await mcp.notification({
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
  record({ event: 'delivered', msg_id: req.msg_id })
  return { status: 'delivered' }
}

function serve(conn) {
  let buf = ''
  conn.setEncoding('utf8')
  conn.on('data', async chunk => {
    buf += chunk
    const nl = buf.indexOf('\n')
    if (nl === -1) {
      if (buf.length > 1_000_000) conn.destroy()
      return
    }
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
// mutex. The kernel allows one binder and releases it when the process dies, so there
// is no stale lock to recover and no read-then-delete race. Whoever holds it may
// replace the (then necessarily stale) socket file; our exit cleanup runs while we
// still hold it, so it can never remove a successor's socket.
function acquireLabel(sockPath) {
  const key = crypto.createHash('sha256').update(sockPath).digest('hex').slice(0, 32)
  const mutex = net.createServer(c => c.destroy())
  return new Promise((resolve, reject) => {
    mutex.once('error', err =>
      reject(err.code === 'EADDRINUSE'
        ? new Error(`another live Claude session already uses label "${label}"; set CC_BRIDGE_LABEL to a different name`)
        : err))
    mutex.listen(`\0cc-bridge-${key}`, resolve)
  })
}

async function listen() {
  if (!mySession) throw new Error('CLAUDE_CODE_SESSION_ID is not set; launch through claude-live')
  const sockPath = paths.socket(label)
  await acquireLabel(sockPath)
  process.on('exit', () => {
    try {
      fs.unlinkSync(sockPath)
    } catch {}
  })
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0))
  process.stdin.on('close', () => process.exit(0))
  try {
    fs.unlinkSync(sockPath) // we own the label, so any socket file here is stale
  } catch {}
  const server = net.createServer(serve)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(sockPath, resolve)
  })
  fs.chmodSync(sockPath, 0o600)
}

await mcp.connect(new StdioServerTransport())
try {
  await listen()
  listening = true
} catch (err) {
  listenError = err.message
  console.error(`cc-bridge: ${err.message}`)
}
