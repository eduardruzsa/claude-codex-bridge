// End-to-end tests: both MCP servers run as real child processes over stdio,
// with fake `codex` and `claude` binaries and isolated data/runtime dirs.
// codex-mcp.js runs under test/fake-codex-parent.js, which holds rollout files
// open the way a real Codex process does.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-'))
const THREAD = '11111111-2222-3333-4444-555555555555'
const OTHER_THREAD = '99999999-2222-3333-4444-555555555555'
const T3 = '33333333-2222-3333-4444-555555555555'
const T4 = '44444444-2222-3333-4444-555555555555'
const T7 = '77777777-2222-3333-4444-555555555555'
const T9 = '90909090-2222-3333-4444-555555555555'
const T10 = 'a0a0a0a0-2222-3333-4444-555555555555'
const T11 = 'b1b1b1b1-2222-3333-4444-555555555555'
const FOREIGN = 'ffffffff-2222-3333-4444-555555555555'
const queueLog = path.join(tmp, 'codex-queue.log')

const env = { ...process.env }
for (const k of Object.keys(env)) if (/^(CLAUDE|CODEX)/.test(k)) delete env[k] // don't leak this machine's sessions
Object.assign(env, {
  CC_BRIDGE_DATA_DIR: path.join(tmp, 'data'),
  CC_BRIDGE_RUNTIME_DIR: path.join(tmp, 'run'),
  CC_BRIDGE_CODEX_BIN: path.join(tmp, 'codex'),
  CC_BRIDGE_CLAUDE_BIN: path.join(tmp, 'claude'),
  CC_BRIDGE_ACTIVE: '1', // these tests aren't started from a claude-live session
  CC_BRIDGE_CLAUDE_PROC: 'none', // ...even when run from inside one
  CC_BRIDGE_TERMINAL: path.join(tmp, 'terminal'),
  CC_BRIDGE_CONFIG: path.join(tmp, 'config.json'), // absent: defaults, never the user's file
})
Object.assign(process.env, env) // so lib/common.js in this process sees the same dirs
fs.mkdirSync(env.CC_BRIDGE_DATA_DIR, { recursive: true, mode: 0o700 })

fs.writeFileSync(env.CC_BRIDGE_CODEX_BIN, `#!/usr/bin/env node
const fs = require('fs')
if (process.env.FAKE_CODEX_FAIL && fs.existsSync(process.env.FAKE_CODEX_FAIL)) { console.error('thread not found'); process.exit(1) }
fs.appendFileSync(${JSON.stringify(queueLog)}, JSON.stringify(process.argv.slice(2)) + '\\n')
console.log('Queued message x for thread ' + process.argv[4] + '.')
`, { mode: 0o755 })

fs.writeFileSync(env.CC_BRIDGE_CLAUDE_BIN, `#!/usr/bin/env node
let input = ''
process.stdin.on('data', d => (input += d)).on('end', () => {
  const args = process.argv.slice(2)
  const r = args.indexOf('--resume')
  const session_id = r === -1 ? 'sess-' + process.pid : args[r + 1]
  console.log(JSON.stringify({ result: 'echo: ' + input + ' | cwd: ' + process.cwd() + ' | args: ' + args.join(' '), session_id, is_error: false }))
})
`, { mode: 0o755 })

fs.writeFileSync(env.CC_BRIDGE_TERMINAL, `#!/usr/bin/env node
const args = process.argv.slice(2)
const fs = require('fs')
const argv = args[1]?.endsWith('/agent-launch.js') ? JSON.parse(fs.readFileSync(require('path').join(process.env.CC_BRIDGE_DATA_DIR, 'launches', args[2] + '.json'))).argv : args
const agentVars = Object.keys(process.env).filter(k => /^(CLAUDE|CODEX|CC_BRIDGE_(LABEL|LIFECYCLE_DIR)$)/.test(k)).sort()
require('fs').appendFileSync(${JSON.stringify(path.join(tmp, 'terminal.log'))}, JSON.stringify({ argv, cwd: process.cwd(), agentVars }) + '\\n')
`, { mode: 0o755 })
const launched = () => {
  const f = path.join(tmp, 'terminal.log')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []
}

const { labelMutexName, pairLive, unpair } = await import('../lib/common.js')

const activeClients = new Set()
async function connect(command, args, extraEnv) {
  const client = new Client({ name: 'test', version: '0' })
  activeClients.add(client)
  const notifications = []
  client.fallbackNotificationHandler = async n => notifications.push(n)
  await client.connect(new StdioClientTransport({ command, args, env: { ...env, ...extraEnv } }))
  // as_thread plays the Codex host: it becomes _meta.threadId, never a tool argument.
  const call = async (name, { as_thread, raw_meta, ...a } = {}) => {
    const _meta = raw_meta || (as_thread && { threadId: as_thread })
    const res = await client.callTool({ name, arguments: a, ...(_meta && { _meta }) })
    return { ok: !res.isError, text: res.content.map(c => c.text).join('') }
  }
  return { client, notifications, call }
}

const sockFile = label => path.join(env.CC_BRIDGE_RUNTIME_DIR, `claude-${label}.sock`)

async function startClaude(label, session, extraEnv = {}) {
  const s = await connect('node', [path.join(root, 'claude-channel.js')], { CC_BRIDGE_LABEL: label, CLAUDE_CODE_SESSION_ID: session, ...extraEnv })
  s.session = session
  return s
}

const startCodex = (threads, extraEnv = {}) =>
  connect('node', [path.join(root, 'test', 'fake-codex-parent.js')], { FAKE_ROLLOUTS: threads.join(','), ...extraEnv })

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('timed out waiting')
}

const queued = () => (fs.existsSync(queueLog) ? fs.readFileSync(queueLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [])
const msgIdFrom = message => message.match(/^msg_id: (\S+)$/m)[1]
const channel = n => n.method === 'notifications/claude/channel'

let claude, codex
before(async () => {
  claude = await startClaude('t1', 'claude-sess-1')
  codex = await startCodex([THREAD, OTHER_THREAD, T3, T4, T7])
  await waitFor(() => fs.existsSync(sockFile('t1')))
  await pairLive('t1', THREAD)
})
after(async () => {
  for (const client of activeClients) await client.close()
  await claude?.client.close()
  await codex?.client.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('Codex → Claude → Codex, with follow-up', async () => {
  const sent = await codex.call('send_to_claude', { text: 'Is the plan sound?', as_thread: THREAD })
  assert.ok(sent.ok, sent.text)
  assert.match(sent.text, /^notification sent.*Receipt unconfirmed/)

  const n = await waitFor(() => claude.notifications.filter(channel).at(-1))
  assert.equal(n.params.content, 'Is the plan sound?')
  assert.equal(n.params.meta.from, `codex:${THREAD}`)
  assert.equal(n.params.meta.kind, 'message')

  const before = queued().length
  const replied = await claude.call('reply', { msg_id: n.params.meta.msg_id, text: 'Mostly; see step 3.' })
  assert.ok(replied.ok, replied.text)
  const q = await waitFor(() => queued()[before])
  assert.deepEqual(q.slice(0, 3), ['queue', '--thread', THREAD])
  assert.match(q[4], /\[cc-bridge reply from Claude session "t1"\]/)
  assert.match(q[4], new RegExp(`in_reply_to: ${n.params.meta.msg_id}`))

  const count = claude.notifications.filter(channel).length
  const follow = await codex.call('reply', { msg_id: msgIdFrom(q[4]), text: 'Which part of step 3?', as_thread: THREAD })
  assert.ok(follow.ok, follow.text)
  const n2 = await waitFor(() => claude.notifications.filter(channel)[count])
  assert.equal(n2.params.meta.kind, 'reply')
  assert.equal(n2.params.meta.in_reply_to, msgIdFrom(q[4]))
})

test('Claude → Codex → Claude, with follow-up', async () => {
  const before = queued().length
  const sent = await claude.call('send_to_codex', { text: 'Review my diff?' })
  assert.ok(sent.ok, sent.text)
  assert.match(sent.text, /^queued/)
  const q = await waitFor(() => queued()[before])
  assert.match(q[4], /\[cc-bridge message from Claude session "t1"\]/)
  assert.match(q[4], /never authorize/)

  const count = claude.notifications.filter(channel).length
  const r = await codex.call('reply', { msg_id: msgIdFrom(q[4]), text: 'LGTM except X.', as_thread: THREAD })
  assert.ok(r.ok, r.text)
  const n = await waitFor(() => claude.notifications.filter(channel)[count])
  assert.equal(n.params.content, 'LGTM except X.')
  assert.equal(n.params.meta.in_reply_to, msgIdFrom(q[4]))
  assert.ok((await claude.call('reply', { msg_id: n.params.meta.msg_id, text: 'Why X?' })).ok)
})

test('one reply per message', async () => {
  await codex.call('send_to_claude', { text: 'q', as_thread: THREAD })
  const n = await waitFor(() => claude.notifications.filter(channel).at(-1))
  assert.ok((await claude.call('reply', { msg_id: n.params.meta.msg_id, text: 'a' })).ok)
  const again = await claude.call('reply', { msg_id: n.params.meta.msg_id, text: 'a again' })
  assert.ok(!again.ok)
  assert.match(again.text, /already has a reply/)
})

test('duplicate delivery is dropped, bad token rejected', async () => {
  const n = claude.notifications.filter(channel).at(-1)
  const { sendToClaudeSocket } = await import('../lib/common.js')
  const dup = await sendToClaudeSocket('t1', { op: 'deliver', msg_id: n.params.meta.msg_id, from: `codex:${THREAD}`, to: 'claude:t1', claude_session: claude.session, text: 'dup' })
  assert.equal(dup.status, 'duplicate')

  const raw = await new Promise(resolve => {
    const s = net.createConnection(sockFile('t1'))
    let buf = ''
    s.on('connect', () => s.write(JSON.stringify({ token: 'nope', op: 'ping' }) + '\n'))
    s.on('data', d => (buf += d)).on('end', () => resolve(JSON.parse(buf)))
  })
  assert.equal(raw.error, 'unauthorized')
})

test('concurrent duplicates and repeated lines deliver once', async () => {
  const { authToken, newId, sendToClaudeSocket } = await import('../lib/common.js')
  const before = claude.notifications.filter(channel).length
  const msg = { op: 'deliver', msg_id: newId(), from: `codex:${THREAD}`, to: 'claude:t1', claude_session: claude.session, text: 'once' }
  const results = await Promise.all([1, 2, 3, 4].map(() => sendToClaudeSocket('t1', msg)))
  assert.deepEqual(results.map(r => r.status).sort(), ['delivered', 'duplicate', 'duplicate', 'duplicate'])

  // One connection writing the same request line twice.
  const line = JSON.stringify({ token: authToken(), ...msg, msg_id: newId() }) + '\n'
  await new Promise(resolve => {
    const s = net.createConnection(sockFile('t1'))
    s.on('connect', () => {
      s.write(line)
      s.write(line)
    })
    s.on('data', () => {}).on('close', resolve)
  })
  await new Promise(r => setTimeout(r, 200))
  assert.equal(claude.notifications.filter(channel).length - before, 2)
})

test('a peer that closes without answering settles the request', async () => {
  const { sendToClaudeSocket } = await import('../lib/common.js')
  const server = net.createServer(c => c.resume().end()) // accept, then hang up silently
  await new Promise(r => server.listen(sockFile('closer'), r))
  const started = Date.now()
  const res = await sendToClaudeSocket('closer', { op: 'ping' }, 5000)
  assert.equal(res.status, 'error')
  assert.match(res.error, /closed without a response/)
  assert.ok(Date.now() - started < 1000)
  await new Promise(r => server.close(r))
})

test('routing errors: unknown session, wrong thread', async () => {
  const unknown = await codex.call('send_to_claude', { text: 'x', session: 'nope', as_thread: THREAD })
  assert.ok(!unknown.ok)
  assert.match(unknown.text, /unknown session/)

  const wrong = await codex.call('send_to_claude', { text: 'x', session: 't1', as_thread: OTHER_THREAD })
  assert.ok(!wrong.ok)
  assert.match(wrong.text, /not rerouting/)
})

test('Codex identity comes from the host _meta, is checked against the process, and cannot be claimed', async () => {
  const foreign = await codex.call('send_to_claude', { text: 'x', session: 't1', as_thread: FOREIGN })
  assert.ok(!foreign.ok)
  assert.match(foreign.text, /not open in the Codex process/)

  const missing = await codex.call('send_to_claude', { text: 'x', session: 't1' })
  assert.ok(!missing.ok)
  assert.match(missing.text, /did not identify the calling thread/)

  // Thread OTHER_THREAD shares the Codex process with THREAD but cannot act as it,
  // not even by naming THREAD in its arguments.
  const impostor = await codex.call('send_to_claude', { text: 'x', session: 't1', codex_thread: THREAD, as_thread: OTHER_THREAD })
  assert.ok(!impostor.ok)
  assert.match(impostor.text, /paired with Codex thread 1111.*not 9999.*not rerouting/)

  const before = claude.notifications.filter(channel).length
  const own = await codex.call('send_to_claude', { text: 'real', as_thread: THREAD })
  assert.ok(own.ok, own.text)
  assert.match((await waitFor(() => claude.notifications.filter(channel)[before])).params.meta.from, new RegExp(THREAD))
  assert.match((await codex.call('bridge_status', { as_thread: THREAD })).text, /t1: paired/)

  // Codex may send the turn metadata as a JSON string instead of an object.
  const asString = await codex.call('bridge_status', { raw_meta: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: THREAD }) } })
  assert.match(asString.text, /t1: paired/)

  const none = await startCodex([])
  const n = await none.call('send_to_claude', { text: 'x', session: 't1', as_thread: THREAD })
  assert.match(n.text, /not open in the Codex process/)
  await none.client.close()
})

test('replies never reach a conversation that took over the label', async () => {
  const a = await startClaude('t7', 'conv-A7')
  await waitFor(() => fs.existsSync(sockFile('t7')))
  await pairLive('t7', T7)
  const before = queued().length
  assert.ok((await a.call('send_to_codex', { text: 'question from A' })).ok)
  const fromA = msgIdFrom((await waitFor(() => queued()[before]))[4])
  assert.ok((await codex.call('send_to_claude', { text: 'question for A', as_thread: T7 })).ok)
  const toA = (await waitFor(() => a.notifications.filter(channel).at(-1))).params.meta.msg_id
  await a.client.close()
  await waitFor(() => !fs.existsSync(sockFile('t7')))

  const b = await startClaude('t7', 'conv-B7')
  await waitFor(() => fs.existsSync(sockFile('t7')))
  await pairLive('t7', T7) // same Codex thread, new conversation
  const r = await codex.call('reply', { msg_id: fromA, text: 'answer for A', as_thread: T7 })
  assert.ok(!r.ok)
  assert.match(r.text, /belongs to Claude conversation conv-A7, not conv-B7; not rerouting/)
  assert.equal(b.notifications.filter(channel).length, 0)

  const rb = await b.call('reply', { msg_id: toA, text: 'B answering A\'s mail' })
  assert.ok(!rb.ok)
  assert.match(rb.text, /belongs to Claude conversation conv-A7, not conv-B7; not rerouting/)
  await b.client.close()
})

test('a new Claude conversation reusing a label does not inherit the pairing', async () => {
  const first = await startClaude('t4', 'conv-A')
  await waitFor(() => fs.existsSync(sockFile('t4')))
  await pairLive('t4', T4)
  assert.ok((await codex.call('send_to_claude', { text: 'to A', as_thread: T4 })).ok)
  await first.client.close()
  await waitFor(() => !fs.existsSync(sockFile('t4')))

  const second = await startClaude('t4', 'conv-B')
  await waitFor(() => fs.existsSync(sockFile('t4')))
  // Codex's connection (conversation A) is gone: it starts a new Claude conversation
  // instead of delivering A's message to B.
  const launches = launched().length
  const toB = await codex.call('send_to_claude', { text: 'meant for A', as_thread: T4, project_dir: tmp })
  assert.ok(toB.ok, toB.text)
  assert.match(toB.text, /"t4" now belongs to another conversation.*new Claude conversation "codex-44444444"/)
  assert.match((await waitFor(() => launched()[launches])).argv.join(' '), /^env CC_BRIDGE_LABEL=codex-44444444 \S+\/bin\/claude-live$/)
  assert.equal(second.notifications.filter(channel).length, 0)

  // B has no connection of its own either: it starts a new Codex conversation.
  const fromB = await second.call('send_to_codex', { text: 'hi' })
  assert.ok(fromB.ok, fromB.text)
  assert.match(fromB.text, /started a new Codex session.*replacing the pairing with thread 4444/)

  const s = await codex.call('bridge_status', { as_thread: T4 })
  assert.match(s.text, /t4: conversation-changed/)

  await pairLive('t4', T4) // explicit re-pair adopts conversation B
  assert.ok((await codex.call('send_to_claude', { text: 'to B', as_thread: T4 })).ok)
  await second.client.close()
})

test('a live label owner is never displaced, even if unresponsive', async () => {
  const dup = await startClaude('t1', 'claude-sess-dup')
  await new Promise(r => setTimeout(r, 300))
  assert.match((await dup.call('bridge_status')).text, /NOT listening: another live Claude session/)
  await dup.client.close()
  assert.ok((await codex.call('send_to_claude', { text: 'still there?', as_thread: THREAD })).ok)

  // A stalled owner: holds the label, answers nothing.
  const stalled = spawn('node', ['-e', `require('net').createServer().listen(${JSON.stringify(labelMutexName('t5'))}, () => console.log('held')); setInterval(() => {}, 1000)`])
  await new Promise(r => stalled.stdout.once('data', r))
  const late = await startClaude('t5', 'claude-sess-late')
  await new Promise(r => setTimeout(r, 300))
  assert.match((await late.call('bridge_status')).text, /NOT listening: another live Claude session/)
  await late.client.close()
  stalled.kill()
})

test('concurrent starters: exactly one wins; a dead owner\'s socket is taken over', async () => {
  fs.writeFileSync(sockFile('t6'), '') // stale socket file left by a dead owner
  const racers = await Promise.all([1, 2, 3, 4, 5, 6].map(i => startClaude('t6', `race-${i}`)))
  await new Promise(r => setTimeout(r, 500))
  const states = await Promise.all(racers.map(r => r.call('bridge_status').then(s => /\(listening\)/.test(s.text))))
  assert.equal(states.filter(Boolean).length, 1)
  const winner = racers[states.indexOf(true)]
  const { sendToClaudeSocket } = await import('../lib/common.js')
  assert.equal((await sendToClaudeSocket('t6', { op: 'ping' })).session, winner.session)
  for (const r of racers.filter(r => r !== winner)) await r.client.close()
  assert.equal((await sendToClaudeSocket('t6', { op: 'ping' })).session, winner.session) // losers' exits left it alone
  await winner.client.close()
  await waitFor(() => !fs.existsSync(sockFile('t6')))
})

test('a socket served by a process outside the mutex is never replaced; the label is released', async () => {
  // e.g. an owner in another network namespace, invisible to the abstract mutex
  const outsider = net.createServer(c => c.resume().end())
  await new Promise(r => outsider.listen(sockFile('t8'), r))
  const blocked = await startClaude('t8', 'conv-t8a')
  await new Promise(r => setTimeout(r, 300))
  assert.match((await blocked.call('bridge_status')).text, /NOT listening: a live process is still serving/)
  assert.ok(fs.existsSync(sockFile('t8')))
  await new Promise(r => outsider.close(r))

  // The failed starter released the label, so a new starter (same process lifetime) can take it.
  const next = await startClaude('t8', 'conv-t8b')
  await new Promise(r => setTimeout(r, 300))
  assert.match((await next.call('bridge_status')).text, /\(listening\)/)
  await next.client.close()
  await blocked.client.close()
})

test('exit cleanup removes only its own socket file', async () => {
  const a = await startClaude('t9', 'conv-t9')
  await waitFor(() => fs.existsSync(sockFile('t9')))
  fs.unlinkSync(sockFile('t9'))
  const successor = net.createServer(c => c.resume().end())
  await new Promise(r => successor.listen(sockFile('t9'), r))
  await a.client.close()
  await new Promise(r => setTimeout(r, 300))
  assert.ok(fs.existsSync(sockFile('t9')), "a's exit removed the successor's socket")
  await new Promise(r => successor.close(r))
})

test('failed codex queue is reported, not retried, and does not consume the reply', async () => {
  const flag = path.join(tmp, 'fail')
  const failing = await startClaude('t2', 'claude-sess-t2', { FAKE_CODEX_FAIL: flag })
  await waitFor(() => fs.existsSync(sockFile('t2')))
  await pairLive('t2', OTHER_THREAD)
  await codex.call('send_to_claude', { text: 'q2', as_thread: OTHER_THREAD })
  const n = await waitFor(() => failing.notifications.filter(channel).at(-1))
  fs.writeFileSync(flag, '')
  const before = queued().length
  const r = await failing.call('reply', { msg_id: n.params.meta.msg_id, text: 'a' })
  assert.ok(!r.ok)
  assert.match(r.text, /not delivered.*thread not found.*not retried/s)
  assert.equal(queued().length, before)
  fs.rmSync(flag)
  assert.ok((await failing.call('reply', { msg_id: n.params.meta.msg_id, text: 'a' })).ok)
  await failing.client.close()
})

test('Codex reopens its paired Claude conversation when it is not running', async () => {
  const gone = await startClaude('t3', 'claude-sess-t3')
  await waitFor(() => fs.existsSync(sockFile('t3')))
  await pairLive('t3', T3)
  await gone.client.close()
  await waitFor(() => !fs.existsSync(sockFile('t3')))
  assert.match((await codex.call('bridge_status', { as_thread: T3 })).text, /t3: disconnected/)

  const launches = launched().length
  const r = await codex.call('send_to_claude', { text: 'hello again', as_thread: T3 })
  assert.ok(r.ok, r.text)
  assert.match(r.text, /wasn't running, so it was reopened/)
  const again = await codex.call('send_to_claude', { text: 'second', as_thread: T3 })
  assert.match(again.text, /already reopening/)
  await new Promise(r => setTimeout(r, 300))
  assert.equal(launched().length, launches + 1, 'one terminal, not two')
  assert.match((await waitFor(() => launched()[launches])).argv.join(' '), /^env CC_BRIDGE_LABEL=t3 \S+\/bin\/claude-live --resume claude-sess-t3$/)

  // The resumed conversation's channel comes up and receives both messages.
  const back = await startClaude('t3', 'claude-sess-t3')
  const got = await waitFor(() => back.notifications.filter(channel).length === 2 && back.notifications.filter(channel))
  assert.deepEqual(got.map(n => n.params.content), ['hello again', 'second'])
  const before = queued().length
  assert.ok((await back.call('reply', { msg_id: got[0].params.meta.msg_id, text: 'welcome back' })).ok)
  assert.deepEqual((await waitFor(() => queued()[before])).slice(0, 3), ['queue', '--thread', T3])
  await back.client.close()
})

test('Codex with no connection starts a new Claude conversation that pairs itself', async () => {
  const lone = await startCodex([T9])
  const launches = launched().length
  const r = await lone.call('send_to_claude', { text: 'fresh start?', as_thread: T9, project_dir: tmp })
  assert.ok(r.ok, r.text)
  const label = 'codex-' + T9.slice(0, 8)
  const l = (await waitFor(() => launched()[launches]))
  assert.equal(l.cwd, tmp)
  assert.equal(l.argv[1], `CC_BRIDGE_LABEL=${label}`)

  const fresh = await startClaude(label, 'conv-fresh')
  const n = await waitFor(() => fresh.notifications.filter(channel)[0])
  assert.equal(n.params.content, 'fresh start?')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.CC_BRIDGE_DATA_DIR, 'pairs.json'), 'utf8'))[label].codex, T9)
  const before = queued().length
  assert.ok((await fresh.call('reply', { msg_id: n.params.meta.msg_id, text: 'yes' })).ok)
  assert.deepEqual((await waitFor(() => queued()[before])).slice(0, 3), ['queue', '--thread', T9])

  // /clear: another conversation now holds the label. The next send must start a new
  // Claude under an unused label, not the occupied one.
  await fresh.client.close()
  await waitFor(() => !fs.existsSync(sockFile(label)))
  const cleared = await startClaude(label, 'conv-cleared')
  await waitFor(() => fs.existsSync(sockFile(label)))
  const launches2 = launched().length
  const r2 = await lone.call('send_to_claude', { text: 'after clear', as_thread: T9, project_dir: tmp })
  assert.ok(r2.ok, r2.text)
  assert.equal((await waitFor(() => launched()[launches2])).argv[1], `CC_BRIDGE_LABEL=${label}-2`)
  assert.equal(cleared.notifications.filter(channel).length, 0)
  const next = await startClaude(`${label}-2`, 'conv-next')
  assert.equal((await waitFor(() => next.notifications.filter(channel)[0])).params.content, 'after clear')
  await next.client.close()
  await cleared.client.close()
  await lone.client.close()
})

test('Claude with no connection starts a new Codex conversation; it connects and gets the message', async () => {
  // What Claude Code gives its MCP servers; none of it may reach the new Codex
  // (its hooks would think they run under Claude, and the token is a secret).
  const solo = await startClaude('t10', 'conv-t10', { CLAUDE_PROJECT_DIR: tmp, CLAUDECODE: '1', CLAUDE_CODE_MESSAGING_TOKEN: 'secret', CLAUDE_CONFIG_DIR: tmp, CODEX_HOME: tmp })
  await waitFor(() => fs.existsSync(sockFile('t10')))
  const launches = launched().length
  const r1 = await solo.call('send_to_codex', { text: 'first' })
  const r2 = await solo.call('send_to_codex', { text: 'second' })
  assert.ok(r1.ok && r2.ok, r1.text + r2.text)
  assert.match(r2.text, /already starting/)
  await new Promise(r => setTimeout(r, 300))
  assert.equal(launched().length, launches + 1, 'one terminal, not two')
  const l = (await waitFor(() => launched()[launches]))
  assert.equal(path.basename(l.argv[0]), 'codex')
  assert.deepEqual(l.agentVars, ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'], 'only user settings, no session of the launching agent')
  assert.match(l.argv[1], /connect_claude tool with project_dir ".*" and session "t10"/)

  // The new Codex thread connects as told and receives both messages.
  const fresh = await startCodex([T10])
  const c = await fresh.call('connect_claude', { project_dir: tmp, session: 't10', as_thread: T10 })
  assert.ok(c.ok, c.text)
  assert.match(c.text, /Pending message\(s\) from Claude:[\s\S]*first[\s\S]*second/)
  const count = solo.notifications.filter(channel).length
  const rep = await fresh.call('reply', { msg_id: msgIdFrom(c.text), text: 'got it', as_thread: T10 })
  assert.ok(rep.ok, rep.text)
  assert.equal((await waitFor(() => solo.notifications.filter(channel)[count])).params.content, 'got it')
  await fresh.client.close()
  await solo.client.close()
})

test('Claude reopens its paired Codex thread when it is not running', async () => {
  const c = await startClaude('t11', 'conv-t11')
  await waitFor(() => fs.existsSync(sockFile('t11')))
  await pairLive('t11', T11) // no process holds T11's rollout open
  const before = queued().length
  const launches = launched().length
  const r = await c.call('send_to_codex', { text: 'are you there?' })
  assert.ok(r.ok, r.text)
  assert.match(r.text, /wasn't running, so it was reopened/)
  const r2 = await c.call('send_to_codex', { text: 'hello?' }) // Codex still starting up
  assert.match(r2.text, /already reopening/)
  assert.deepEqual((await waitFor(() => queued()[before + 1])).slice(0, 3), ['queue', '--thread', T11])
  assert.deepEqual((await waitFor(() => launched()[launches])).argv.slice(1, 3), ['resume', T11])
  await new Promise(r => setTimeout(r, 300))
  assert.equal(launched().length, launches + 1, 'one terminal, not two')
  await c.client.close()
})

test('the channel is dormant unless Claude was started with it', async () => {
  const d = await connect('node', [path.join(root, 'claude-channel.js')], { CC_BRIDGE_LABEL: 'dormant', CLAUDE_CODE_SESSION_ID: 'x', CC_BRIDGE_ACTIVE: '' })
  assert.deepEqual((await d.client.listTools()).tools, [])
  await new Promise(r => setTimeout(r, 300))
  assert.ok(!fs.existsSync(sockFile('dormant')))
  await d.client.close()

  const { launchedWithChannel, sweepLifecycleDirs } = await import('../lib/claude-process.js')
  // Lifecycle state is swept only once its Claude process (pid + start time) has ended.
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8')
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  const live = path.join(env.CC_BRIDGE_RUNTIME_DIR, `proc-${process.pid}-${start}`)
  const gone = path.join(env.CC_BRIDGE_RUNTIME_DIR, `proc-${process.pid}-1`)
  for (const d of [live, gone]) fs.mkdirSync(d, { recursive: true })
  sweepLifecycleDirs()
  assert.ok(fs.existsSync(live))
  assert.ok(!fs.existsSync(gone))
  fs.rmSync(live, { recursive: true })

  assert.ok(launchedWithChannel(['claude', '--dangerously-load-development-channels', 'plugin:cc-bridge@cc-bridge', '--continue']))
  assert.ok(launchedWithChannel(['claude', '--channels=plugin:other@x,plugin:cc-bridge@local']))
  assert.ok(!launchedWithChannel(['claude', '--continue']))
  assert.ok(!launchedWithChannel(['claude', '--dangerously-load-development-channels', 'plugin:fakechat@official', 'plugin:cc-bridge@x']) === false)
  assert.ok(!launchedWithChannel(['claude', '-p', 'plugin:cc-bridge@cc-bridge']))
})

test('pairing requires a live Claude session', async () => {
  const r = await codex.call('pair_with_claude', { session: 'ghost', as_thread: THREAD })
  assert.ok(!r.ok)
  assert.match(r.text, /not running/)
})

test('consult_claude: restricted, registry-only resume, original cwd kept', async () => {
  const other = fs.mkdtempSync(path.join(tmp, 'other-'))
  const first = await codex.call('consult_claude', { prompt: 'What does lib/common.js do?', label: 'arch', cwd: root })
  assert.ok(first.ok, first.text)
  assert.match(first.text, /--restricted --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --strict-mcp-config/)
  assert.doesNotMatch(first.text, /--resume/)
  const sid = first.text.match(/\[session_id: (\S+)\]/)[1]

  const follow = await codex.call('consult_claude', { prompt: 'And deliver.js?', session_id: sid })
  assert.ok(follow.ok, follow.text)
  assert.match(follow.text, new RegExp(`--resume ${sid}`))
  assert.match(follow.text, new RegExp(`cwd: ${root}`))

  const moved = await codex.call('consult_claude', { prompt: 'x', session_id: sid, cwd: other })
  assert.ok(!moved.ok)
  assert.match(moved.text, /cwd cannot change/)

  const foreign = await codex.call('consult_claude', { prompt: 'x', session_id: '0000cccc-0000-4000-8000-00000000c003' })
  assert.ok(!foreign.ok)
  assert.match(foreign.text, /not a cc-bridge consultation/)

  assert.match((await codex.call('list_consultations')).text, new RegExp(`${sid} {2}"arch" {2}2 turn\\(s\\)`))
})

test('private permissions on data and runtime', () => {
  const mode = p => fs.statSync(p).mode & 0o777
  assert.equal(mode(env.CC_BRIDGE_DATA_DIR), 0o700)
  assert.equal(mode(env.CC_BRIDGE_RUNTIME_DIR), 0o700)
  assert.equal(mode(path.join(env.CC_BRIDGE_DATA_DIR, 'transcript.jsonl')), 0o600)
  assert.equal(mode(path.join(env.CC_BRIDGE_DATA_DIR, 'token')), 0o600)
  assert.equal(mode(path.join(env.CC_BRIDGE_DATA_DIR, 'pairs.json')), 0o600)
  assert.equal(mode(sockFile('t1')), 0o600)
})


test('pair_with_claude hands over bootstrap requests with their original IDs', async () => {
  const t = 'c2c2c2c2-2222-3333-4444-555555555555'
  const source = await startClaude('compat-bootstrap', 'compat-conversation')
  await waitFor(() => fs.existsSync(sockFile('compat-bootstrap')))
  const sent = await source.call('send_to_codex', { text: 'compatibility handover' })
  assert.ok(sent.ok, sent.text)
  const id = sent.text.match(/Request ([0-9a-f-]{36})/)[1]
  const receiver = await startCodex([t])
  const result = await receiver.call('pair_with_claude', { session: 'compat-bootstrap', as_thread: t })
  assert.ok(result.ok, result.text)
  assert.match(result.text, /compatibility handover/)
  assert.equal(msgIdFrom(result.text), id)
  const second = await receiver.call('connect_claude', { session: 'compat-bootstrap', project_dir: tmp, as_thread: t })
  assert.doesNotMatch(second.text, /compatibility handover/)
  await source.client.close(); await receiver.client.close()
})


test('a second fresh bootstrap after unpair does not inherit the old destination', async () => {
  const source = await startClaude('bootstrap-twice', 'same-conversation')
  await waitFor(() => fs.existsSync(sockFile('bootstrap-twice')))
  const t1 = 'e1e1e1e1-2222-3333-4444-555555555555'
  const t2 = 'e2e2e2e2-2222-3333-4444-555555555555'
  const receiver = await startCodex([t1, t2])
  assert.ok((await source.call('send_to_codex', { text: 'first bootstrap' })).ok)
  assert.match((await receiver.call('connect_claude', { project_dir: tmp, session: 'bootstrap-twice', as_thread: t1 })).text, /first bootstrap/)
  await unpair('bootstrap-twice')
  assert.ok((await source.call('send_to_codex', { text: 'second bootstrap' })).ok)
  const result = await receiver.call('connect_claude', { project_dir: tmp, session: 'bootstrap-twice', as_thread: t2 })
  assert.ok(result.ok, result.text)
  assert.match(result.text, /second bootstrap/)
  assert.doesNotMatch(result.text, /first bootstrap/)
  await source.client.close(); await receiver.client.close()
})

test('a channel without launch ownership preserves pending requests instead of draining them', async () => {
  const { addPending, readPending } = await import('../lib/pending.js')
  const { reserveLaunch, updateLaunch } = await import('../lib/launch-state.js')
  const { processIdentity } = await import('../lib/store.js')
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await new Promise(r => owner.once('spawn', r))
  let channelServer
  try {
    await addPending('claude', 'wrong-owner', { codex: THREAD, claude_session: null, cwd: tmp }, 'keep waiting')
    const attempt = await reserveLaunch({ kind: 'claude', label: 'wrong-owner', codex: THREAD, claude_session: null, cwd: tmp, argv: ['false'] })
    await updateLaunch(attempt.launch.id, { state: 'running', owner: processIdentity(owner.pid) })
    channelServer = await startClaude('wrong-owner', 'manual-conversation')
    await waitFor(() => fs.existsSync(sockFile('wrong-owner')))
    await new Promise(r => setTimeout(r, 800))
    assert.equal(readPending('claude', 'wrong-owner').messages[0].state, 'pending')
    assert.equal(channelServer.notifications.filter(channel).length, 0)
  } finally { owner.kill(); await channelServer?.client.close() }
})


test('retry hands a leftover pending request to a live paired Codex without opening a window', async () => {
  const { addPending, readPending } = await import('../lib/pending.js')
  const { retryMessage } = await import('../lib/recovery.js')
  const t = 'f3f3f3f3-2222-3333-4444-555555555555'
  const source = await startClaude('leftover', 'leftover-conversation')
  const receiver = await startCodex([t])
  await waitFor(() => fs.existsSync(sockFile('leftover')))
  await pairLive('leftover', t)
  const request = await addPending('codex', 'leftover', { claude_session: 'leftover-conversation', cwd: tmp }, 'leftover request')
  const launches = launched().length
  const before = queued().length
  assert.match(await retryMessage(request.msg_id), /existing Codex conversation; no new window/)
  assert.equal(launched().length, launches)
  const q = await waitFor(() => queued()[before])
  assert.match(q[4], new RegExp(request.msg_id))
  assert.equal(readPending('codex', 'leftover').messages[0].state, 'queued')
  await source.client.close(); await receiver.client.close()
})
