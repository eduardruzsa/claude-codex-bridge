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
const FOREIGN = 'ffffffff-2222-3333-4444-555555555555'
const queueLog = path.join(tmp, 'codex-queue.log')

const env = { ...process.env }
for (const k of Object.keys(env)) if (/^(CLAUDE|CODEX)/.test(k)) delete env[k] // don't leak this machine's sessions
Object.assign(env, {
  CC_BRIDGE_DATA_DIR: path.join(tmp, 'data'),
  CC_BRIDGE_RUNTIME_DIR: path.join(tmp, 'run'),
  CC_BRIDGE_CODEX_BIN: path.join(tmp, 'codex'),
  CC_BRIDGE_CLAUDE_BIN: path.join(tmp, 'claude'),
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

const { pairLive } = await import('../lib/common.js')

async function connect(command, args, extraEnv) {
  const client = new Client({ name: 'test', version: '0' })
  const notifications = []
  client.fallbackNotificationHandler = async n => notifications.push(n)
  await client.connect(new StdioClientTransport({ command, args, env: { ...env, ...extraEnv } }))
  const call = async (name, a = {}) => {
    const res = await client.callTool({ name, arguments: a })
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
  codex = await startCodex([THREAD, OTHER_THREAD, T3, T4])
  await waitFor(() => fs.existsSync(sockFile('t1')))
  await pairLive('t1', THREAD)
})
after(async () => {
  await claude?.client.close()
  await codex?.client.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('Codex → Claude → Codex, with follow-up', async () => {
  const sent = await codex.call('send_to_claude', { text: 'Is the plan sound?', codex_thread: THREAD })
  assert.ok(sent.ok, sent.text)
  assert.match(sent.text, /^delivered/)

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
  const follow = await codex.call('reply', { msg_id: msgIdFrom(q[4]), text: 'Which part of step 3?', codex_thread: THREAD })
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
  const r = await codex.call('reply', { msg_id: msgIdFrom(q[4]), text: 'LGTM except X.', codex_thread: THREAD })
  assert.ok(r.ok, r.text)
  const n = await waitFor(() => claude.notifications.filter(channel)[count])
  assert.equal(n.params.content, 'LGTM except X.')
  assert.equal(n.params.meta.in_reply_to, msgIdFrom(q[4]))
  assert.ok((await claude.call('reply', { msg_id: n.params.meta.msg_id, text: 'Why X?' })).ok)
})

test('one reply per message', async () => {
  await codex.call('send_to_claude', { text: 'q', codex_thread: THREAD })
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

test('routing errors: unknown session, wrong thread, unpaired', async () => {
  const unknown = await codex.call('send_to_claude', { text: 'x', session: 'nope', codex_thread: THREAD })
  assert.ok(!unknown.ok)
  assert.match(unknown.text, /unknown session/)

  const wrong = await codex.call('send_to_claude', { text: 'x', session: 't1', codex_thread: OTHER_THREAD })
  assert.ok(!wrong.ok)
  assert.match(wrong.text, /not rerouting/)

  const orphan = await startClaude('orphan', 'claude-sess-orphan')
  const r = await orphan.call('send_to_codex', { text: 'x' })
  assert.ok(!r.ok)
  assert.match(r.text, /not paired/)
  await orphan.client.close()
})

test('Codex identity is verified against the parent process, never inferred from the recipient', async () => {
  const foreign = await codex.call('send_to_claude', { text: 'x', session: 't1', codex_thread: FOREIGN })
  assert.ok(!foreign.ok)
  assert.match(foreign.text, /not a thread of the Codex process/)

  const missing = await codex.call('send_to_claude', { text: 'x', session: 't1' })
  assert.ok(!missing.ok)
  assert.match(missing.text, /several threads; pass codex_thread/)

  const foreignReply = await codex.call('reply', { msg_id: 'whatever', text: 'x', codex_thread: FOREIGN })
  assert.match(foreignReply.text, /not a thread of the Codex process/)

  // A Codex process with exactly one open thread is identified without codex_thread.
  const single = await startCodex([THREAD])
  const r = await single.call('send_to_claude', { text: 'from the single-thread process' })
  assert.ok(r.ok, r.text)
  const s = await single.call('bridge_status')
  assert.match(s.text, new RegExp(`this thread: ${THREAD}`))
  await single.client.close()

  const none = await startCodex([])
  const n = await none.call('send_to_claude', { text: 'x', session: 't1', codex_thread: THREAD })
  assert.match(n.text, /not a thread of the Codex process/)
  await none.client.close()
})

test('a new Claude conversation reusing a label does not inherit the pairing', async () => {
  const first = await startClaude('t4', 'conv-A')
  await waitFor(() => fs.existsSync(sockFile('t4')))
  await pairLive('t4', T4)
  assert.ok((await codex.call('send_to_claude', { text: 'to A', codex_thread: T4 })).ok)
  await first.client.close()
  await waitFor(() => !fs.existsSync(sockFile('t4')))

  const second = await startClaude('t4', 'conv-B')
  await waitFor(() => fs.existsSync(sockFile('t4')))
  const toB = await codex.call('send_to_claude', { text: 'meant for A', codex_thread: T4 })
  assert.ok(!toB.ok)
  assert.match(toB.text, /^session_changed/)
  assert.equal(second.notifications.filter(channel).length, 0)

  const fromB = await second.call('send_to_codex', { text: 'hi' })
  assert.ok(!fromB.ok)
  assert.match(fromB.text, /belongs to Claude conversation conv-A/)

  const s = await codex.call('bridge_status', { codex_thread: T4 })
  assert.match(s.text, /claude "t4" \(conversation conv-A\) ⇄ codex 4444.*session changed \(now conv-B; re-pair\)/)

  await pairLive('t4', T4) // explicit re-pair adopts conversation B
  assert.ok((await codex.call('send_to_claude', { text: 'to B', codex_thread: T4 })).ok)
  await second.client.close()
})

test('a live label owner is never displaced, even if unresponsive', async () => {
  const dup = await startClaude('t1', 'claude-sess-dup')
  await new Promise(r => setTimeout(r, 300))
  assert.match((await dup.call('bridge_status')).text, /NOT listening: another live Claude session/)
  await dup.client.close()
  assert.ok((await codex.call('send_to_claude', { text: 'still there?', codex_thread: THREAD })).ok)

  // A stalled owner: alive, holds the lock, answers nothing.
  const stalled = spawn('node', ['-e', 'setInterval(() => {}, 1000)', 'claude-channel-stalled'], { stdio: 'ignore' })
  fs.writeFileSync(`${sockFile('t5')}.lock`, String(stalled.pid))
  const late = await startClaude('t5', 'claude-sess-late')
  await new Promise(r => setTimeout(r, 300))
  assert.match((await late.call('bridge_status')).text, new RegExp(`NOT listening: another live Claude session \\(pid ${stalled.pid}\\)`))
  assert.ok(fs.existsSync(`${sockFile('t5')}.lock`))
  await late.client.close()
  stalled.kill()
})

test('a dead owner\'s lock and socket are taken over; cleanup only removes our own', async () => {
  const dead = spawn('node', ['-e', '0'])
  await new Promise(r => dead.on('exit', r))
  fs.writeFileSync(`${sockFile('t6')}.lock`, String(dead.pid))
  fs.writeFileSync(sockFile('t6'), '') // stale socket file
  const s = await startClaude('t6', 'claude-sess-t6')
  await new Promise(r => setTimeout(r, 300))
  assert.match((await s.call('bridge_status')).text, /\(listening\)/)
  assert.notEqual(Number(fs.readFileSync(`${sockFile('t6')}.lock`, 'utf8')), dead.pid)
  const { sendToClaudeSocket } = await import('../lib/common.js')
  assert.equal((await sendToClaudeSocket('t6', { op: 'ping' })).session, 'claude-sess-t6')
  await s.client.close()
  await waitFor(() => !fs.existsSync(`${sockFile('t6')}.lock`) && !fs.existsSync(sockFile('t6')))
})

test('failed codex queue is reported, not retried, and does not consume the reply', async () => {
  const flag = path.join(tmp, 'fail')
  const failing = await startClaude('t2', 'claude-sess-t2', { FAKE_CODEX_FAIL: flag })
  await waitFor(() => fs.existsSync(sockFile('t2')))
  await pairLive('t2', OTHER_THREAD)
  await codex.call('send_to_claude', { text: 'q2', codex_thread: OTHER_THREAD })
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

test('disconnected Claude session is reported explicitly', async () => {
  const gone = await startClaude('t3', 'claude-sess-t3')
  await waitFor(() => fs.existsSync(sockFile('t3')))
  await pairLive('t3', T3)
  await gone.client.close()
  await waitFor(() => !fs.existsSync(sockFile('t3')))
  const r = await codex.call('send_to_claude', { text: 'hello?', codex_thread: T3 })
  assert.ok(!r.ok)
  assert.match(r.text, /^disconnected/)
  assert.match((await codex.call('bridge_status', { codex_thread: T3 })).text, /claude "t3" .*: disconnected/)
})

test('pairing requires a live Claude session', async () => {
  const r = await codex.call('pair_with_claude', { session: 'ghost', codex_thread: THREAD })
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

  const foreign = await codex.call('consult_claude', { prompt: 'x', session_id: '01184467-e553-4231-8810-02911556b239' })
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
  assert.equal(mode(`${sockFile('t1')}.lock`), 0o600)
})
