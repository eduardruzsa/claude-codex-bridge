// End-to-end tests: both MCP servers run as real child processes over stdio,
// with fake `codex` and `claude` binaries and isolated data/runtime dirs.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-test-'))
const THREAD = '11111111-2222-3333-4444-555555555555'
const OTHER_THREAD = '99999999-2222-3333-4444-555555555555'
const queueLog = path.join(tmp, 'codex-queue.log')

const env = {
  ...process.env,
  CC_BRIDGE_DATA_DIR: path.join(tmp, 'data'),
  CC_BRIDGE_RUNTIME_DIR: path.join(tmp, 'run'),
  CC_BRIDGE_CODEX_BIN: path.join(tmp, 'codex'),
  CC_BRIDGE_CLAUDE_BIN: path.join(tmp, 'claude'),
}
delete env.CODEX_THREAD_ID
Object.assign(process.env, env) // so lib/common.js in this process sees the same dirs

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
  const session_id = r === -1 ? 'sess-new' : args[r + 1]
  console.log(JSON.stringify({ result: 'echo: ' + input + ' | args: ' + args.join(' '), session_id, is_error: false }))
})
`, { mode: 0o755 })

const { pairSessions } = await import('../lib/common.js')

async function startServer(script, extraEnv = {}) {
  const client = new Client({ name: 'test', version: '0' })
  const notifications = []
  client.fallbackNotificationHandler = async n => notifications.push(n)
  await client.connect(new StdioClientTransport({ command: 'node', args: [path.join(root, script)], env: { ...env, ...extraEnv } }))
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args })
    return { ok: !res.isError, text: res.content.map(c => c.text).join('') }
  }
  return { client, notifications, call }
}

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
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
  pairSessions('t1', THREAD)
  claude = await startServer('claude-channel.js', { CC_BRIDGE_LABEL: 't1' })
  codex = await startServer('codex-mcp.js')
  await waitFor(() => fs.existsSync(path.join(env.CC_BRIDGE_RUNTIME_DIR, 'claude-t1.sock')))
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
  assert.match(q[4], /Mostly; see step 3\./)

  // Codex follows up on Claude's reply.
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
  assert.match(q[4], /does not authorize|never authorize/)

  const count = claude.notifications.filter(channel).length
  const r = await codex.call('reply', { msg_id: msgIdFrom(q[4]), text: 'LGTM except X.', codex_thread: THREAD })
  assert.ok(r.ok, r.text)
  const n = await waitFor(() => claude.notifications.filter(channel)[count])
  assert.equal(n.params.content, 'LGTM except X.')
  assert.equal(n.params.meta.in_reply_to, msgIdFrom(q[4]))

  const follow = await claude.call('reply', { msg_id: n.params.meta.msg_id, text: 'Why X?' })
  assert.ok(follow.ok, follow.text)
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
  const { authToken, sendToClaudeSocket } = await import('../lib/common.js')
  authToken()
  const dup = await sendToClaudeSocket('t1', { op: 'deliver', msg_id: n.params.meta.msg_id, from: `codex:${THREAD}`, to: 'claude:t1', text: 'dup' })
  assert.equal(dup.status, 'duplicate')

  const raw = await new Promise(resolve => {
    const s = net.createConnection(path.join(env.CC_BRIDGE_RUNTIME_DIR, 'claude-t1.sock'))
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

  const orphan = await startServer('claude-channel.js', { CC_BRIDGE_LABEL: 'orphan' })
  const r = await orphan.call('send_to_codex', { text: 'x' })
  assert.ok(!r.ok)
  assert.match(r.text, /not paired/)
  await orphan.client.close()
})

test('label collision refuses to take over a live socket', async () => {
  const dup = await startServer('claude-channel.js', { CC_BRIDGE_LABEL: 't1' })
  await new Promise(r => setTimeout(r, 300))
  const s = await dup.call('bridge_status')
  assert.match(s.text, /NOT listening: another live Claude session/)
  const sent = await dup.call('send_to_codex', { text: 'x' })
  assert.ok(!sent.ok)
  await dup.client.close()
  // the original session still receives
  assert.ok((await codex.call('send_to_claude', { text: 'still there?', codex_thread: THREAD })).ok)
})

test('failed codex queue is reported, not retried, and does not consume the reply', async () => {
  const flag = path.join(tmp, 'fail')
  const failing = await startServer('claude-channel.js', { CC_BRIDGE_LABEL: 't2', FAKE_CODEX_FAIL: flag })
  pairSessions('t2', OTHER_THREAD)
  await waitFor(() => fs.existsSync(path.join(env.CC_BRIDGE_RUNTIME_DIR, 'claude-t2.sock')))
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
  const gone = await startServer('claude-channel.js', { CC_BRIDGE_LABEL: 't3' })
  pairSessions('t3', '33333333-2222-3333-4444-555555555555')
  await waitFor(() => fs.existsSync(path.join(env.CC_BRIDGE_RUNTIME_DIR, 'claude-t3.sock')))
  await gone.client.close()
  await waitFor(() => !fs.existsSync(path.join(env.CC_BRIDGE_RUNTIME_DIR, 'claude-t3.sock')))
  const r = await codex.call('send_to_claude', { text: 'hello?', session: 't3', codex_thread: '33333333-2222-3333-4444-555555555555' })
  assert.ok(!r.ok)
  assert.match(r.text, /^disconnected/)
  const s = await codex.call('bridge_status')
  assert.match(s.text, /claude "t3" ⇄ codex 33333333-.*: disconnected/)
})

test('consult_claude is read-only, resumable, and listed', async () => {
  const first = await codex.call('consult_claude', { prompt: 'What does lib/common.js do?', label: 'arch', cwd: root })
  assert.ok(first.ok, first.text)
  assert.match(first.text, /--tools Read,Grep,Glob --allowedTools Read,Grep,Glob --strict-mcp-config/)
  assert.doesNotMatch(first.text, /--resume/)
  assert.match(first.text, /\[session_id: sess-new\]/)

  const follow = await codex.call('consult_claude', { prompt: 'And deliver.js?', session_id: 'sess-new', cwd: root })
  assert.match(follow.text, /--resume sess-new/)

  const list = await codex.call('list_consultations')
  assert.match(list.text, /sess-new {2}"arch" {2}2 turn\(s\)/)
})

test('private permissions on data and runtime', () => {
  const mode = p => fs.statSync(p).mode & 0o777
  assert.equal(mode(env.CC_BRIDGE_DATA_DIR), 0o700)
  assert.equal(mode(env.CC_BRIDGE_RUNTIME_DIR), 0o700)
  assert.equal(mode(path.join(env.CC_BRIDGE_DATA_DIR, 'transcript.jsonl')), 0o600)
  assert.equal(mode(path.join(env.CC_BRIDGE_DATA_DIR, 'token')), 0o600)
  assert.equal(mode(path.join(env.CC_BRIDGE_RUNTIME_DIR, 'claude-t1.sock')), 0o600)
})
