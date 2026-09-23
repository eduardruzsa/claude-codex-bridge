import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { test, after } from 'node:test'
const root = path.resolve(import.meta.dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-reliability-'))
Object.assign(process.env, { CC_BRIDGE_DATA_DIR: path.join(tmp, 'data'), CC_BRIDGE_RUNTIME_DIR: path.join(tmp, 'run'), CC_BRIDGE_CONFIG: path.join(tmp, 'config.json') })
fs.mkdirSync(process.env.CC_BRIDGE_DATA_DIR, { mode: 0o700 })
const { addPending, claimPending, finishPending, beginHandover, releaseClaim, readPending, pendingFile, cancelPending, bindPending } = await import('../lib/pending.js')
const { messages, stateLabel } = await import('../lib/messages.js')
const { record, validateReply, newId } = await import('../lib/common.js')
const { withStoreLock, writeStore, processIdentity } = await import('../lib/store.js')
const { reserveLaunch, readLaunch, acceptLaunch, updateLaunch, launchState } = await import('../lib/launch-state.js')
const { listSessions, formatSessions } = await import('../lib/discovery.js')
const key = { claude_session: 'original', cwd: tmp }
const children = new Set()
after(() => { for (const c of children) c.kill(); fs.rmSync(tmp, { recursive: true, force: true }) })

async function waitFor(fn) {
  for (let i = 0; i < 150; i++) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 20)) }
  throw new Error('Timed out')
}
function child(code) {
  const c = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(c)
  let err = ''
  c.stderr.on('data', d => err += d)
  c.done = new Promise((resolve, reject) => c.once('exit', n => { children.delete(c); n === 0 ? resolve() : reject(new Error(err || `exit ${n}`)) }))
  return c
}

test('late sends retain IDs, content and original timestamps; pending cannot be replied to', async () => {
  const a = await addPending('codex', 'slow', key, 'first', 1000)
  const b = await addPending('codex', 'slow', key, 'second', 900000)
  assert.equal(b.launch, false)
  assert.deepEqual(readPending('codex', 'slow').messages.map(m => m.text), ['first', 'second'])
  assert.equal(readPending('codex', 'slow').messages[0].created_at, new Date(1000).toISOString())
  assert.throws(() => validateReply(a.msg_id, 'codex:x', 'original'), /unknown/)
  const claimed = await claimPending('codex', 'slow')
  assert.equal(claimed.message.msg_id, a.msg_id)
  await bindPending('codex', 'slow', a.msg_id, 'thread')
  await finishPending('codex', 'slow', a.msg_id, 'unconfirmed', 'response handover')
  assert.equal((await claimPending('codex', 'slow')).message.msg_id, b.msg_id)
  await finishPending('codex', 'slow', b.msg_id, 'unconfirmed')
  assert.equal(messages().find(m => m.msg_id === a.msg_id).created_at, new Date(1000).toISOString())
})

test('cross-process appends and claims do not lose or double-claim requests', async () => {
  const script = `import { addPending } from './lib/pending.js'; await addPending('codex', 'race', ${JSON.stringify(key)}, String(process.pid));`
  await Promise.all(Array.from({ length: 6 }, () => child(script).done))
  assert.equal(readPending('codex', 'race').messages.length, 6)
  const claims = await Promise.all(Array.from({ length: 6 }, () => claimPending('codex', 'race')))
  assert.equal(claims.filter(Boolean).length, 1)
  await finishPending('codex', 'race', claims.find(Boolean).message.msg_id, 'queued')
  assert.ok(await claimPending('codex', 'race'))
})

test('lock timeout rejects acceptance without changing saved requests', async () => {
  await addPending('codex', 'busy', key, 'keep')
  const before = fs.readFileSync(pendingFile('codex', 'busy'), 'utf8')
  await withStoreLock('pending:codex:busy', async () => {
    await assert.rejects(withStoreLock('pending:codex:busy', () => assert.fail('entered'), 40), /request not accepted/)
  })
  assert.equal(fs.readFileSync(pendingFile('codex', 'busy'), 'utf8'), before)
})

test('conversation changes retain dropped content; cancellation never recalls claimed messages', async () => {
  const a = await addPending('codex', 'changed', key, 'old content')
  const b = await addPending('codex', 'changed', { ...key, claude_session: 'new' }, 'new content')
  assert.equal(messages().find(m => m.msg_id === a.msg_id).state, 'dropped')
  assert.equal(messages().find(m => m.msg_id === a.msg_id).text, 'old content')
  await cancelPending(b.msg_id)
  assert.equal(await claimPending('codex', 'changed'), null)
  const c = await addPending('codex', 'changed', { ...key, claude_session: 'new' }, 'claimed')
  await claimPending('codex', 'changed')
  await assert.rejects(cancelPending(c.msg_id), /already claimed/)
})

test('legacy records get stable IDs; interrupted claim is preserved as unconfirmed', async () => {
  writeStore(pendingFile('codex', 'legacy'), { ...key, started_at: 1000, messages: [{ text: 'legacy', ts: 1100 }] })
  const p = await claimPending('codex', 'legacy')
  assert.match(p.message.msg_id, /^[0-9a-f-]{36}$/)
  assert.equal(p.message.created_at, new Date(1100).toISOString())
  await beginHandover('codex', 'legacy', p.message.msg_id, p.message.claim_id)
  const stored = readPending('codex', 'legacy')
  stored.messages[0].owner = { pid: 999999999, start: '0' }
  writeStore(pendingFile('codex', 'legacy'), stored)
  assert.equal(await claimPending('codex', 'legacy'), null)
  assert.equal(readPending('codex', 'legacy').messages[0].state, 'unconfirmed')
  assert.equal(messages().find(m => m.msg_id === p.message.msg_id).state, 'unconfirmed')
})

test('a reply changes displayed state without claiming the notification was read', () => {
  const id = newId()
  record({ event: 'sent', msg_id: id, from: 'codex:t', to: 'claude:display', text: 'question' })
  record({ event: 'notification_sent', msg_id: id })
  assert.match(stateLabel(messages().find(m => m.msg_id === id).state), /receipt unconfirmed/)
  record({ event: 'sent', msg_id: newId(), reply_to: id, from: 'claude:display', to: 'codex:t', text: 'answer' })
  assert.equal(messages().find(m => m.msg_id === id).state, 'replied')
})

test('launch reservations survive timeout and process restart; fallback bootstrap binds once', async () => {
  const spec = { kind: 'codex', label: 'startup', claude_session: 'original', codex: null, cwd: tmp, argv: ['false'] }
  const a = await reserveLaunch(spec)
  await updateLaunch(a.launch.id, { created_at: '2000-01-01T00:00:00.000Z' })
  const b = await reserveLaunch(spec)
  assert.equal(b.fresh, false)
  assert.equal(b.launch.id, a.launch.id)
  await acceptLaunch('codex', 'startup', 'thread') // model omitted launch_id
  await assert.rejects(acceptLaunch('codex', 'startup', 'other-thread'), /another conversation/)
  await updateLaunch(a.launch.id, { state: 'exited' })
  assert.equal((await reserveLaunch(spec)).fresh, true) // a subsequent user send can resume a formerly connected agent
})

test('wrapper records executable failure and closed windows are not automatically reopened', async () => {
  const spec = { kind: 'claude', label: 'wrapper', claude_session: null, codex: 't', cwd: tmp, argv: ['/no/such/cc-bridge-agent'] }
  const { launch } = await reserveLaunch(spec)
  const c = spawn(process.execPath, ['bin/agent-launch.js', launch.id], { cwd: root, env: process.env, stdio: 'ignore' })
  await new Promise(r => c.once('exit', r))
  assert.equal(readLaunch(launch.id).state, 'failed')
  assert.ok(readLaunch(launch.id).owner.start)
  assert.equal((await reserveLaunch(spec)).fresh, false)
  const retry = await reserveLaunch({ ...spec, argv: [process.execPath, '-e', 'process.exit(0)'] }, true)
  const closed = spawn(process.execPath, ['bin/agent-launch.js', retry.launch.id], { cwd: root, env: process.env, stdio: 'ignore' })
  await new Promise(r => closed.once('exit', r))
  assert.equal(readLaunch(retry.launch.id).state, 'exited')
  assert.equal((await reserveLaunch(spec)).fresh, false)
})

test('late superseded wrappers do not start; live wrappers cannot be retried', async () => {
  const spec = { kind: 'codex', label: 'late', claude_session: 's', codex: null, cwd: tmp, argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(path.join(tmp, 'unexpected'))}, 'bad')`] }
  const first = await reserveLaunch(spec)
  await updateLaunch(first.launch.id, { created_at: '2000-01-01T00:00:00.000Z' })
  await reserveLaunch(spec, true)
  const c = spawn(process.execPath, ['bin/agent-launch.js', first.launch.id], { cwd: root, env: process.env, stdio: 'ignore' })
  await new Promise(r => c.once('exit', r))
  assert.equal(fs.existsSync(path.join(tmp, 'unexpected')), false)
  await assert.rejects(acceptLaunch('codex', 'late', 'thread'), /ambiguous/)
  const active = await reserveLaunch({ ...spec, label: 'alive' })
  await updateLaunch(active.launch.id, { owner: processIdentity(), state: 'running' })
  await assert.rejects(reserveLaunch({ ...spec, label: 'alive' }, true), /still open/)
  assert.equal(launchState(readLaunch(active.launch.id)), 'running')
  await updateLaunch(active.launch.id, { owner: null, state: 'exited' })
})

test('CLI help, version, validation, log and verbose output use standard conventions', async () => {
  const run = args => spawnSync(process.execPath, ['bin/cc-bridge', ...args], { cwd: root, env: process.env, encoding: 'utf8' })
  for (const args of [['--help'], ['help'], ['log', '--help'], ['--version']]) assert.equal(run(args).status, 0)
  for (const args of [['unknown'], ['log', '-n', '0'], ['log', '-n'], ['status', '--wat'], ['config', 'set', 'terminal']]) {
    const r = run(args); assert.equal(r.status, 2, r.stderr); assert.ok(r.stderr); assert.equal(r.stdout, '')
  }
  const log = run(['log', '-n', '100'])
  assert.equal(log.status, 0, log.stderr)
  assert.match(log.stdout, /old content/)
  assert.match(log.stdout, /dropped/)
  const sessions = await listSessions()
  assert.match(formatSessions(sessions), /waiting request/)
})

test('retrying an already queued message reopens only the original conversation', async () => {
  const { retryMessage } = await import('../lib/recovery.js')
  const { paths } = await import('../lib/common.js')
  const thread = 'dddddddd-2222-3333-4444-555555555555'
  const terminal = path.join(tmp, 'terminal')
  const opened = path.join(tmp, 'opened')
  fs.writeFileSync(terminal, `#!/bin/sh\nprintf opened >> '${opened}'\n`, { mode: 0o755 })
  const oldTerminal = process.env.CC_BRIDGE_TERMINAL
  process.env.CC_BRIDGE_TERMINAL = terminal
  writeStore(paths.pairs(), { recover: { codex: thread, claude_session: 'original', cwd: tmp } })
  const id = newId()
  record({ event: 'sent', msg_id: id, from: 'claude:recover', to: `codex:${thread}`, claude_session: 'original', text: 'already accepted', kind: 'message' })
  record({ event: 'queued', msg_id: id })
  const before = messages().find(m => m.msg_id === id)
  try {
    assert.match(await retryMessage(id), /not sent again/)
    await waitFor(() => fs.existsSync(opened))
    assert.equal(messages().find(m => m.msg_id === id).state, before.state)
    writeStore(paths.pairs(), { recover: { codex: thread, claude_session: 'different', cwd: tmp } })
    await assert.rejects(retryMessage(id), /not rerouting/)
  } finally {
    if (oldTerminal === undefined) delete process.env.CC_BRIDGE_TERMINAL; else process.env.CC_BRIDGE_TERMINAL = oldTerminal
  }
})


test('pre-transport rejection releases a claim; expired claims cannot be used by their old owner', async () => {
  const a = await addPending('claude', 'reject', { codex: 'thread', claude_session: null, cwd: tmp }, 'preserve me')
  const p = await claimPending('claude', 'reject')
  await releaseClaim('claude', 'reject', a.msg_id, p.message.claim_id, 'startup identity rejected')
  assert.equal(readPending('claude', 'reject').messages[0].state, 'pending')
  const second = await claimPending('claude', 'reject')
  const stored = readPending('claude', 'reject')
  stored.messages[0].claimed_at = 0
  writeStore(pendingFile('claude', 'reject'), stored)
  const third = await claimPending('claude', 'reject')
  assert.ok(third)
  await assert.rejects(beginHandover('claude', 'reject', a.msg_id, second.message.claim_id), /expired/)
  await releaseClaim('claude', 'reject', a.msg_id, third.message.claim_id, 'test finished')
  await cancelPending(a.msg_id)
})

test('a completed bootstrap does not bind future requests to its old thread', async () => {
  const first = await addPending('codex', 'rebind', key, 'first')
  const p = await claimPending('codex', 'rebind')
  await bindPending('codex', 'rebind', first.msg_id, 'old-thread', p.message.claim_id)
  await finishPending('codex', 'rebind', first.msg_id, 'unconfirmed', '', p.message.claim_id)
  const next = await addPending('codex', 'rebind', key, 'new request')
  const claimed = await claimPending('codex', 'rebind')
  assert.equal(claimed.message.msg_id, next.msg_id)
  await bindPending('codex', 'rebind', next.msg_id, 'new-thread', claimed.message.claim_id)
  assert.equal(readPending('codex', 'rebind').codex, 'new-thread')
})

test('retry waits for a slow terminal and refuses while an orphan agent is alive', async () => {
  const spec = { kind: 'codex', label: 'orphan', claude_session: 'original', codex: null, cwd: tmp, argv: ['false'] }
  const { launch } = await reserveLaunch(spec)
  await assert.rejects(reserveLaunch(spec, true), /still opening/)
  await updateLaunch(launch.id, { state: 'running', owner: { pid: 999999999, start: '0' }, agent: processIdentity() })
  await assert.rejects(reserveLaunch(spec, true), /still open/)
  const { callerLaunch } = await import('../lib/launch-state.js')
  assert.equal(callerLaunch('codex').id, launch.id)
  await updateLaunch(launch.id, { owner: null, agent: null, state: 'exited' })
})

test('a terminal that exits unsuccessfully records failure instead of waiting forever', async () => {
  const { launchCodex } = await import('../lib/launch.js')
  const old = process.env.CC_BRIDGE_TERMINAL
  const terminal = path.join(tmp, 'failed-terminal')
  fs.writeFileSync(terminal, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  process.env.CC_BRIDGE_TERMINAL = terminal
  try {
    const result = await launchCodex(tmp, ['hello'], 'bad-terminal', 'session')
    await waitFor(() => readLaunch(result.launch.id).state === 'failed')
    assert.match(readLaunch(result.launch.id).error, /launcher exited 1/)
  } finally { if (old === undefined) delete process.env.CC_BRIDGE_TERMINAL; else process.env.CC_BRIDGE_TERMINAL = old }
})

test('a send during bootstrap completion joins the same launch generation', async () => {
  const spec = { kind: 'codex', label: 'completion-race', claude_session: 's', codex: null, cwd: tmp, argv: ['false'], generation: 'batch-one' }
  const first = await reserveLaunch(spec)
  await acceptLaunch('codex', spec.label, 'thread-one')
  const concurrent = await reserveLaunch(spec)
  assert.equal(concurrent.fresh, false)
  assert.equal(concurrent.launch.id, first.launch.id)
  const later = await reserveLaunch({ ...spec, generation: 'batch-two' })
  assert.equal(later.fresh, true)
})


test('completed startup provenance does not restrict new threads or explicit labels', async () => {
  const spec = { kind: 'codex', label: 'completed', claude_session: 's', codex: null, cwd: tmp, argv: ['false'] }
  const { launch } = await reserveLaunch(spec)
  await updateLaunch(launch.id, { state: 'running', owner: processIdentity() })
  await acceptLaunch('codex', 'completed', 'original-thread')
  assert.equal((await acceptLaunch('codex', 'another-label', 'new-thread')).id, launch.id)
  await reserveLaunch({ ...spec, claude_session: 'new-conversation' })
  assert.equal((await acceptLaunch('codex', 'another-label', 'new-thread')).id, launch.id)
  // Clear the synthetic test process ownership without modifying the superseded record.
  const { launchFile } = await import('../lib/launch-state.js')
  const old = readLaunch(launch.id)
  writeStore(launchFile(launch.id), { ...old, owner: null })
})

test('legacy adoption permits a later reopen instead of reserving startup forever', async () => {
  await addPending('claude', 'legacy-start', { codex: 'thread', claude_session: 'session', cwd: tmp }, 'legacy')
  const adopted = await acceptLaunch('claude', 'legacy-start', 'session')
  assert.equal(adopted.state, 'exited')
  const next = await reserveLaunch({ kind: 'claude', label: 'legacy-start', codex: 'thread', claude_session: 'session', cwd: tmp, argv: ['false'] })
  assert.equal(next.fresh, true)
})


test('a completed manual connection never reverts to startup-unconfirmed after timeout', async () => {
  const { launch } = await reserveLaunch({ kind: 'codex', label: 'manual-completed', claude_session: 's', codex: null, cwd: tmp, argv: ['false'] })
  await updateLaunch(launch.id, { connected: 'thread', created_at: '2000-01-01T00:00:00.000Z' })
  assert.notEqual((await listSessions()).find(s => s.label === 'manual-completed').state, 'startup unconfirmed')
})
