#!/usr/bin/env node
// Codex side of the bridge: an MCP server Codex launches over stdio.
// Sends to the paired live Claude session's channel socket, answers Claude
// messages (which arrive in Codex via `codex queue`), and runs separate
// read-only `claude -p` consultations.
import { spawn } from 'node:child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  RULES,
  claudeSessionAlive,
  codexParty,
  labelForThread,
  loadConsultations,
  loadPairs,
  pairSessions,
  parseParty,
  readTranscript,
  saveConsultation,
  validLabel,
  validateReply,
} from './lib/common.js'
import { deliverToClaude } from './lib/deliver.js'

const CONSULT_TOOLS = 'Read,Grep,Glob'
const CONSULT_TIMEOUT_MS = 10 * 60 * 1000
const claudeBin = () => process.env.CC_BRIDGE_CLAUDE_BIN || 'claude'

const THREAD_ARG = {
  type: 'string',
  description: 'Your Codex thread id. Codex does not pass it to MCP servers, so run `echo $CODEX_THREAD_ID` once and pass it on every cc-bridge call.',
}

const TOOLS = [
  {
    name: 'send_to_claude',
    description: `Start a new exchange with the paired live Claude Code session. Returns immediately with delivered/disconnected/unknown session; Claude's answer arrives later as a queued message in this thread. ${RULES}`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The question or message for Claude' },
        session: { type: 'string', description: 'Claude session label; defaults to the one paired with this thread' },
        codex_thread: THREAD_ARG,
      },
      required: ['text'],
    },
  },
  {
    name: 'reply',
    description: 'Answer a Claude message that arrived as a "[cc-bridge ... from Claude ...]" message. Each message accepts one reply; to follow up on a Claude reply, reply to that reply\'s msg_id.',
    inputSchema: {
      type: 'object',
      properties: {
        msg_id: { type: 'string', description: 'The msg_id line of the Claude message being answered' },
        text: { type: 'string' },
        codex_thread: THREAD_ARG,
      },
      required: ['msg_id', 'text'],
    },
  },
  {
    name: 'bridge_status',
    description: 'List Claude sessions paired with Codex threads, whether each is connected, and recent bridge messages.',
    inputSchema: { type: 'object', properties: { codex_thread: THREAD_ARG } },
  },
  {
    name: 'pair_with_claude',
    description: 'Pair this Codex thread with a live Claude session label (one-to-one; replaces any previous pairing of either side).',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string', description: 'Claude session label (CC_BRIDGE_LABEL, default "claude")' }, codex_thread: THREAD_ARG },
      required: ['session'],
    },
  },
  {
    name: 'consult_claude',
    description: 'Ask a separate, dedicated Claude instance (not the live session) a question. It can only read and search files (Read, Grep, Glob). Pass the returned session_id to follow up with context. Blocks until Claude answers. Uses the user\'s Claude usage.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        session_id: { type: 'string', description: 'session_id from an earlier consult_claude call, to follow up' },
        label: { type: 'string', description: 'Short name for this consultation, shown by list_consultations' },
        cwd: { type: 'string', description: 'Directory Claude works in; defaults to this server\'s working directory' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'list_consultations',
    description: 'List dedicated Claude consultations with their session_id, label, and directory.',
    inputSchema: { type: 'object', properties: {} },
  },
]

const text = t => ({ content: [{ type: 'text', text: t }] })
const fail = t => ({ content: [{ type: 'text', text: t }], isError: true })

function myThread(args) {
  return args.codex_thread || process.env.CODEX_THREAD_ID || null
}

async function sendToClaude(args) {
  const thread = myThread(args)
  const label = args.session || (thread && labelForThread(thread))
  if (!label) return fail('unknown session: no Claude session label given and this thread is not paired. Use pair_with_claude or pass session.')
  if (!validLabel(label)) return fail(`unknown session: invalid label "${label}"`)
  const paired = loadPairs()[label]
  if (!paired) return fail(`unknown session: Claude session "${label}" is not paired with any Codex thread`)
  if (thread && paired !== thread) return fail(`Claude session "${label}" is paired with Codex thread ${paired}, not ${thread}; not rerouting`)
  const res = await deliverToClaude({ fromThread: paired, label, text: String(args.text || '') })
  if (res.status === 'delivered') {
    return text(`delivered to Claude session "${label}" (msg_id ${res.msg_id}). Claude's answer, if any, arrives later as a queued message.`)
  }
  return fail(`${res.status}: Claude session "${label}" did not receive msg_id ${res.msg_id}${res.error ? ` (${res.error})` : ''}. Not retried.`)
}

async function replyToClaude(args) {
  const events = readTranscript()
  const original = events.find(e => e.event === 'sent' && e.msg_id === args.msg_id)
  if (!original) return fail(`unknown msg_id ${args.msg_id}`)
  const { side, id: thread } = parseParty(original.to)
  if (side !== 'codex') return fail(`msg_id ${args.msg_id} was not addressed to Codex`)
  const mine = myThread(args)
  if (mine && mine !== thread) return fail(`msg_id ${args.msg_id} was addressed to Codex thread ${thread}, not ${mine}`)
  validateReply(args.msg_id, codexParty(thread), events)
  const label = parseParty(original.from).id
  if (loadPairs()[label] !== thread) return fail(`Claude session "${label}" is no longer paired with thread ${thread}; not rerouting`)
  const res = await deliverToClaude({ fromThread: thread, label, text: String(args.text || ''), replyToId: original.msg_id, kind: 'reply' })
  if (res.status === 'delivered') return text(`reply delivered to Claude session "${label}" (msg_id ${res.msg_id}).`)
  return fail(`${res.status}: reply msg_id ${res.msg_id} not delivered to Claude session "${label}"${res.error ? ` (${res.error})` : ''}. Not retried.`)
}

async function status(args) {
  const pairs = Object.entries(loadPairs())
  const lines = [`this thread: ${myThread(args) || 'unknown (pass codex_thread)'}`, 'pairings:']
  for (const [label, thread] of pairs) {
    lines.push(`  claude "${label}" ⇄ codex ${thread}: ${(await claudeSessionAlive(label)) ? 'connected' : 'disconnected'}`)
  }
  if (!pairs.length) lines.push('  (none)')
  lines.push('recent:')
  const recent = readTranscript().filter(e => e.event === 'sent').slice(-10)
  for (const e of recent) lines.push(`  ${e.ts} ${e.kind} ${e.from} → ${e.to} msg_id=${e.msg_id}${e.reply_to ? ` in_reply_to=${e.reply_to}` : ''}`)
  if (!recent.length) lines.push('  (none)')
  return text(lines.join('\n'))
}

function consult(args) {
  const cliArgs = [
    '-p',
    '--output-format', 'json',
    '--tools', CONSULT_TOOLS,
    '--allowedTools', CONSULT_TOOLS,
    '--strict-mcp-config',
  ]
  if (args.session_id) cliArgs.push('--resume', args.session_id)
  const cwd = args.cwd || process.cwd()
  return new Promise(resolve => {
    const child = spawn(claudeBin(), cliArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), CONSULT_TIMEOUT_MS)
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('error', e => {
      clearTimeout(timer)
      resolve(fail(`could not start claude: ${e.message}`))
    })
    child.on('close', code => {
      clearTimeout(timer)
      let result
      try {
        result = JSON.parse(out)
      } catch {
        resolve(fail(`claude exited ${code} without JSON output: ${(err || out).trim().slice(-500)}`))
        return
      }
      if (result.session_id) {
        const prev = loadConsultations().find(c => c.session_id === result.session_id)
        saveConsultation({
          session_id: result.session_id,
          label: args.label || prev?.label || String(args.prompt).slice(0, 60),
          cwd,
          created: prev?.created || new Date().toISOString(),
          updated: new Date().toISOString(),
          turns: (prev?.turns || 0) + 1,
        })
      }
      const body = `${result.result ?? ''}\n\n[session_id: ${result.session_id}]`
      resolve(result.is_error ? fail(body) : text(body))
    })
    child.stdin.end(String(args.prompt))
  })
}

const mcp = new Server(
  { name: 'cc-bridge', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'cc-bridge connects this Codex thread to a live Claude Code session. Claude messages arrive as ' +
      '"[cc-bridge message|reply from Claude session ...]" with a msg_id; answer with `reply`. Start exchanges ' +
      `with \`send_to_claude\`. Your ordinary output is NOT forwarded to Claude. ${RULES} ` +
      '`consult_claude` is a separate read-only Claude, independent of the live session.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = req.params.arguments || {}
  try {
    switch (req.params.name) {
      case 'send_to_claude':
        return await sendToClaude(args)
      case 'reply':
        return await replyToClaude(args)
      case 'bridge_status':
        return await status(args)
      case 'pair_with_claude': {
        const thread = myThread(args)
        if (!thread) return fail('cannot tell which Codex thread this is; pass codex_thread (run: echo $CODEX_THREAD_ID)')
        const replaced = pairSessions(String(args.session), thread)
        const note = replaced.filter(r => r.claude !== args.session || r.codex !== thread)
        return text(`paired Claude session "${args.session}" ⇄ Codex thread ${thread}` +
          (note.length ? `\nreplaced: ${note.map(r => `"${r.claude}" ⇄ ${r.codex}`).join(', ')}` : ''))
      }
      case 'consult_claude':
        return await consult(args)
      case 'list_consultations': {
        const all = loadConsultations()
        return text(all.length
          ? all.map(c => `${c.session_id}  "${c.label}"  ${c.turns} turn(s)  ${c.cwd}  updated ${c.updated}`).join('\n')
          : '(no consultations yet)')
      }
      default:
        return fail(`unknown tool: ${req.params.name}`)
    }
  } catch (err) {
    return fail(err.message)
  }
})

await mcp.connect(new StdioServerTransport())
