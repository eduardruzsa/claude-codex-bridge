#!/usr/bin/env node
// Codex side of the bridge: an MCP server Codex launches over stdio.
// Sends to the paired live Claude session's channel socket, answers Claude
// messages (which arrive in Codex via `codex queue`), and runs separate
// read-only `claude -p` consultations.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  RULES,
  claudeParty,
  codexParty,
  formatForCodex,
  record,
  sendToClaudeSocket,
  consultArgs,
  findMessage,
  isUuid,
  labelForThread,
  loadConsultations,
  loadPairs,
  pairLive,
  parseParty,
  readTranscript,
  saveConsultation,
  validLabel,
  validateReply,
} from './lib/common.js'
import { deliverToClaude } from './lib/deliver.js'
import { connectClaude, listSessions, formatSessions } from './lib/discovery.js'
import { addPending, launchClaude, readPending, claimPending, finishPending } from './lib/launch.js'
import { bindPending, beginHandover, releaseClaim } from './lib/pending.js'
import { messages, formatMessages } from './lib/messages.js'
import { acceptLaunch, callerLaunch } from './lib/launch-state.js'
import { withStoreLock } from './lib/store.js'
import { config } from './lib/config.js'
import { version } from './lib/version.js'

const claudeBin = () => config().claude_bin

const TOOLS = [
  {
    name: 'list_sessions',
    description: 'Discover live Claude conversations, their projects, exact identities and pairing state. Use before selecting between multiple conversations.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'connect_claude',
    description: 'Use send_to_claude for ordinary requests. Connect here for bridge bootstrap or an explicitly selected existing conversation. Reuses a valid pairing, otherwise connects only to the sole unpaired Claude in project_dir. If ambiguous or changed, ask the user to select a label, then pass session. Never choose a replacement silently.',
    inputSchema: { type: 'object', properties: {
      project_dir: { type: 'string', description: 'Absolute working directory of your current project (not the MCP server directory)' },
      session: { type: 'string', description: 'User-selected existing label or the label supplied by bridge bootstrap' },
      launch_id: { type: 'string', description: 'Optional bootstrap launch ID; host process ancestry is authoritative' },
    }, required: ['project_dir'] },
  },
  {
    name: 'send_to_claude',
    description: `Start a new exchange with Claude Code. Uses the Claude conversation paired with this thread; if it isn't running, reopens it in a new terminal, and if this thread has no connection, starts a NEW Claude conversation in a terminal in project_dir. Returns immediately; Claude's answer arrives later as a queued message in this thread. ${RULES}`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The question or message for Claude' },
        project_dir: { type: 'string', description: 'Absolute path of your current working directory; a new Claude conversation starts there' },
        session: { type: 'string', description: 'Claude session label; defaults to the one paired with this thread' },
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
      },
      required: ['msg_id', 'text'],
    },
  },
  {
    name: 'bridge_status',
    description: 'List Claude sessions paired with Codex threads, whether each is connected, and recent bridge messages.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pair_with_claude',
    description: 'Pair this Codex thread with a live Claude session label (one-to-one; replaces any previous pairing of either side).',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string', description: 'Claude session label (CC_BRIDGE_LABEL, default "claude")' } },
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
        session_id: { type: 'string', description: 'session_id from an earlier consult_claude call (see list_consultations), to follow up; it keeps its original directory' },
        label: { type: 'string', description: 'Short name for this consultation, shown by list_consultations' },
        cwd: { type: 'string', description: 'Directory Claude may read, for a new consultation; defaults to this server\'s working directory' },
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

// Codex thread identity comes from the Codex host, not the model: every tools/call
// carries _meta.threadId for the calling thread. As a second check it must be a thread
// whose rollout-<ts>-<uuid>.jsonl the Codex process that launched us holds open.
function openCodexThreads() {
  const threads = new Set()
  const fdDir = `/proc/${process.ppid}/fd`
  let fds = []
  try {
    fds = fs.readdirSync(fdDir)
  } catch {
    return threads
  }
  for (const fd of fds) {
    try {
      const m = fs.readlinkSync(`${fdDir}/${fd}`).match(/\/rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
      if (m) threads.add(m[1].toLowerCase())
    } catch {}
  }
  return threads
}

function turnMetadata(meta) {
  const raw = meta?.['x-codex-turn-metadata']
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function callerThread(meta) {
  const t = String(meta?.threadId || turnMetadata(meta)?.thread_id || '').toLowerCase()
  if (!isUuid(t)) throw new Error('Codex did not identify the calling thread (no _meta.threadId on the tool call)')
  const provenance = callerLaunch('codex')
  if (provenance?.state === 'superseded' && !provenance.connected) throw new Error('This startup was superseded; use the current agent window.')
  if (!openCodexThreads().has(t)) throw new Error(`calling thread ${t} is not open in the Codex process running this bridge`)
  return t
}

async function sendToClaude(args, thread) {
  const body = String(args.text || '')
  if (args.session && !validLabel(args.session)) return fail(`unknown session: invalid label "${args.session}"`)
  if (args.session && !loadPairs()[args.session]) return fail(`unknown session: Claude session "${args.session}" is not paired with any Codex thread`)
  const label = args.session || labelForThread(thread)
  const pair = label && loadPairs()[label]
  if (pair && pair.codex !== thread) return fail(`Claude session "${label}" is paired with Codex thread ${pair.codex}, not ${thread}; not rerouting`)
  if (pair) {
    const ping = await sendToClaudeSocket(label, { op: 'ping' }, 2000)
    if (ping.status === 'ok' && ping.session === pair.claude_session) {
      const res = await deliverToClaude({ fromThread: thread, label, claudeSession: pair.claude_session, text: body })
      if (res.status === 'delivered') {
        return text(`notification sent to Claude session "${label}" (msg_id ${res.msg_id}). Receipt unconfirmed; Claude's answer, if any, arrives later as a queued message.`)
      }
      return fail(`${res.status}: handover of msg_id ${res.msg_id} to Claude session "${label}" was not confirmed${res.error ? ` (${res.error})` : ''}. Not retried.`)
    }
    if (ping.status === 'transitioning') return fail(`Claude session "${label}" is switching conversations; try again shortly.`)
    if (ping.status === 'disconnected') {
      // The paired conversation isn't running: reopen it and deliver once it's up.
      const cwd = pair.cwd || projectDir(args)
      const { msg_id } = await addPending('claude', label, { codex: thread, claude_session: pair.claude_session, cwd }, body)
      const attempt = await launchPreservingRequests(label, () => launchClaude(cwd, label, ['--resume', pair.claude_session], thread))
      if (['failed', 'exited'].includes(attempt.launch.state)) return text(`Request ${msg_id} is preserved; the agent window closed or startup failed. Run: cc-bridge retry ${msg_id}`)
      return text(`Claude conversation ${pair.claude_session} wasn't running, so it ${attempt.fresh ? 'was reopened' : 'is already reopening'} in a terminal in ${cwd}. ` +
        `Request ${msg_id} is waiting for connection; approve the channel prompt there. The answer arrives later as a queued message.`)
    }
    if (ping.status !== 'ok') return fail(`Claude session "${label}" did not answer (${ping.status}${ping.error ? `: ${ping.error}` : ''}); not starting another. Not retried.`)
    // ok but a different conversation now owns the label: this thread has no connection.
  }
  return startNewClaude(thread, projectDir(args), body, pair ? label : null)
}

function projectDir(args) {
  const dir = args.project_dir || process.cwd()
  if (!fs.statSync(dir).isDirectory()) throw new Error(`project_dir is not a directory: ${dir}`)
  return dir
}

async function launchPreservingRequests(label, launch) {
  try {
    return await launch()
  } catch (err) {
    // Keep pending requests after a failed launch.
    const request = readPending('claude', label)?.messages.find(m => m.state === 'pending')
    throw new Error(`${err.message}. Request ${request?.msg_id || ''} is preserved. Run: cc-bridge retry ${request?.msg_id || '<message-id>'}`)
  }
}

// No connection: start a NEW Claude conversation under a fresh label; it pairs with
// this thread and receives the message as soon as its channel is up.
async function startNewClaude(thread, cwd, body, oldLabel) {
  return withStoreLock('new-claude', async () => {
  const label = await freshLabel(thread)
  const { msg_id, batch_id } = await addPending('claude', label, { codex: thread, claude_session: null, cwd }, body)
  const attempt = await launchPreservingRequests(label, () => launchClaude(cwd, label, [], thread, false, batch_id))
  if (['failed', 'exited'].includes(attempt.launch.state)) return text(`Request ${msg_id} is preserved; startup needs recovery. Run: cc-bridge retry ${msg_id}`)
  return text(`This thread had no running Claude connection${oldLabel ? ` ("${oldLabel}" now belongs to another conversation)` : ''}, ` +
    `so a new Claude conversation "${label}" ${attempt.fresh ? 'was started' : 'is already starting'} in a terminal in ${cwd}. ` +
    `Request ${msg_id} is waiting for connection; approve the prompts there. The answer arrives later as a queued message.`)
  })
}

// A label for a new Claude conversation: one already starting for this thread (so a
// second send joins it), otherwise one with no pairing, no live channel and no
// pending start. A label a /clear-ed conversation still holds is never reused.
async function freshLabel(thread) {
  const base = `codex-${thread.slice(0, 8)}`
  const candidates = [base, ...Array.from({ length: 50 }, (_, i) => `${base}-${i + 2}`)]
  for (const label of candidates) {
    const pending = readPending('claude', label)
    if (pending && pending.codex === thread && pending.claude_session === null && pending.messages.some(m => !m.state || m.state === 'pending') && (await sendToClaudeSocket(label, { op: 'ping' }, 1000)).status === 'disconnected') return label
  }
  for (const label of candidates) {
    const pending = readPending('claude', label)
    if (loadPairs()[label] || pending?.messages.some(m => ['pending', 'claimed'].includes(m.state || 'pending'))) continue
    if ((await sendToClaudeSocket(label, { op: 'ping' }, 1000)).status !== 'disconnected') continue
    return label
  }
  throw new Error(`no free Claude label left for ${base}; clean up with cc-bridge unpair`)
}

// Messages Claude left while this Codex was being started for it.
async function takePendingFromClaude(label, pair) {
  const messages = []
  let warning = ''
  for (;;) {
    let pending
    try {
      pending = await claimPending('codex', label)
      if (!pending) break
      const m = pending.message
      if (pending.claude_session !== pair.claude_session || (pending.codex && pending.codex !== pair.codex)) {
        await finishPending('codex', label, m.msg_id, 'dropped', 'Claude conversation changed', m.claim_id)
        continue
      }
      await bindPending('codex', label, m.msg_id, pair.codex, m.claim_id)
      await beginHandover('codex', label, m.msg_id, m.claim_id)
      record({ event: 'sent', msg_id: m.msg_id, created_at: m.created_at, from: claudeParty(label), to: codexParty(pair.codex), claude_session: pair.claude_session, reply_to: null, kind: 'message', text: m.text })
      messages.push(formatForCodex({ msgId: m.msg_id, fromLabel: label, replyToId: null, kind: 'message', text: m.text }))
      await finishPending('codex', label, m.msg_id, 'unconfirmed', 'Included in connection response; receipt confirmed only by a reply', m.claim_id)
    } catch (err) {
      if (pending) {
        try { await releaseClaim('codex', label, pending.message.msg_id, pending.message.claim_id, err.message) } catch {}
      }
      warning = `\nFurther handover delayed: ${err.message}. Call connect_claude again with session ${label} to collect remaining requests. Earlier messages remain valid.`
      break // return already prepared messages even if a later operation fails
    }
  }
  return (messages.length ? `\n\nPending message(s) from Claude:\n\n${messages.join('\n\n')}` : '') + warning
}

async function replyToClaude(args, thread) {
  const events = readTranscript()
  const original = findMessage(args.msg_id, events)
  if (!original) return fail(`unknown msg_id ${args.msg_id}`)
  const { side, id: label } = parseParty(original.from)
  if (side !== 'claude') return fail(`msg_id ${args.msg_id} did not come from Claude`)
  const pair = loadPairs()[label]
  if (pair?.codex !== thread) return fail(`Claude session "${label}" is no longer paired with thread ${thread}; not rerouting`)
  validateReply(args.msg_id, codexParty(thread), pair.claude_session, events)
  const res = await deliverToClaude({ fromThread: thread, label, claudeSession: pair.claude_session, text: String(args.text || ''), replyToId: original.msg_id, kind: 'reply' })
  if (res.status === 'delivered') return text(`reply notification sent to Claude session "${label}" (msg_id ${res.msg_id}); receipt unconfirmed.`)
  return fail(`${res.status}: reply msg_id ${res.msg_id} not notification sent to Claude session "${label}"${res.error ? ` (${res.error})` : ''}. Not retried.`)
}

async function status(meta) {
  const thread = callerThread(meta)
  const recent = messages().filter(m => m.from === codexParty(thread) || m.to === codexParty(thread)).slice(-10)
  return text(formatSessions(await listSessions()) + '\n\n' + formatMessages(recent))
}

function consult(args) {
  // Follow-ups may only resume consultations this bridge created, in their original directory.
  let prev
  if (args.session_id) {
    prev = loadConsultations().find(c => c.session_id === args.session_id)
    if (!prev) return fail(`session_id ${args.session_id} is not a cc-bridge consultation (see list_consultations)`)
    if (args.cwd && args.cwd !== prev.cwd) return fail(`consultation ${args.session_id} works in ${prev.cwd}; cwd cannot change on follow-up`)
  }
  const cliArgs = consultArgs(prev?.session_id)
  const cwd = prev?.cwd || args.cwd || process.cwd()
  return new Promise(resolve => {
    const child = spawn(claudeBin(), cliArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), config().consult_timeout_seconds * 1000)
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
  { name: 'cc-bridge', version },
  {
    capabilities: { tools: {} },
    instructions:
      'cc-bridge connects this Codex thread to a live Claude Code session (Codex identifies the calling thread automatically). ' +
      'When the user asks you to ask Claude, call send_to_claude with your project_dir: it uses this thread\'s Claude connection, reopens it if needed, or starts a new Claude conversation when there is none. ' +
      'Use connect_claude for bridge bootstrap instructions or to attach to an existing Claude conversation the user names (list_sessions shows them). ' +
      'Claude messages arrive as "[cc-bridge message|reply from Claude session ...]" with a msg_id; answer with `reply`. Start exchanges ' +
      `with \`send_to_claude\`. Your ordinary output is NOT forwarded to Claude. ${RULES} ` +
      '`consult_claude` is a separate read-only Claude, independent of the live session.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = req.params.arguments || {}
  const meta = req.params._meta
  try {
    const provenance = callerLaunch('codex')
    if (provenance && !provenance.connected) {
      callerThread(meta) // reject late superseded startups on every tool path
      if (provenance.codex) await acceptLaunch('codex', provenance.label, callerThread(meta)) // resumed known thread
    }
    switch (req.params.name) {
      case 'list_sessions':
        return text(JSON.stringify(await listSessions(), null, 2))
      case 'connect_claude': {
        const thread = callerThread(meta)
        const provenance = callerLaunch('codex')
        if (!args.session && provenance && !provenance.connected) args.session = provenance.label
        const pending = args.session && readPending('codex', args.session)
        if (args.session && (provenance || pending?.messages.some(m => ['pending', 'claimed'].includes(m.state || 'pending')))) await acceptLaunch('codex', args.session, thread, args.launch_id)
        const result = await connectClaude(thread, args.project_dir, args.session, pending?.claude_session)
        return text(`Connected Claude "${result.label}" (${result.pair.claude_session}) ⇄ Codex ${result.pair.codex}` +
          await takePendingFromClaude(result.label, result.pair))
      }
      case 'send_to_claude':
        return await sendToClaude(args, callerThread(meta))
      case 'reply':
        return await replyToClaude(args, callerThread(meta))
      case 'bridge_status':
        return await status(meta)
      case 'pair_with_claude': {
        const thread = callerThread(meta)
        const pending = readPending('codex', String(args.session))
        if (callerLaunch('codex') || pending?.messages.some(m => ['pending', 'claimed'].includes(m.state || 'pending'))) await acceptLaunch('codex', String(args.session), thread, args.launch_id)
        const { pair, replaced } = await pairLive(String(args.session), thread, { expectedSession: pending?.claude_session })
        return text(`paired Claude session "${args.session}" (conversation ${pair.claude_session}) ⇄ Codex thread ${thread}` +
          (replaced.length ? `\nreplaced: ${replaced.map(r => `"${r.claude}" ⇄ ${r.codex}`).join(', ')}` : '') + await takePendingFromClaude(String(args.session), pair))
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
