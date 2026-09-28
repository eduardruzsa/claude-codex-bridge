import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { test, after } from 'node:test'

const tmp = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'ccb-platform-'))
Object.assign(process.env, {
  CC_BRIDGE_DATA_DIR: path.join(tmp, 'data'), CC_BRIDGE_RUNTIME_DIR: path.join(tmp, 'run'),
  CC_BRIDGE_CONFIG: path.join(tmp, 'config.json'), CC_BRIDGE_CLAUDE_PROC: 'none',
})
after(() => fs.rmSync(tmp, { recursive: true, force: true }))
const { processIdentity, processAlive } = await import('../lib/store.js')
const { runningCodexThreads } = await import('../lib/launch.js')

test('process identity is stable, includes parent and rejects a recycled PID', () => {
  const identity = processIdentity()
  assert.ok(identity?.start)
  assert.equal(identity.parent, process.ppid)
  assert.equal(processIdentity().start, identity.start)
  assert.equal(processAlive(identity), true)
  assert.equal(processAlive({ ...identity, start: '0' }), false)
  assert.equal(processIdentity(999999999), null)
})

test('running threads come from open rollout files', () => {
  const thread = 'abcdefab-1234-4321-abcd-abcdefabcdef'
  const fd = fs.openSync(path.join(tmp, `rollout-now-${thread}.jsonl`), 'w')
  try { assert.ok(runningCodexThreads().has(thread)) } finally { fs.closeSync(fd) }
  assert.equal(runningCodexThreads().has(thread), false)
})

const { acquireMutex, processInfo, openRolloutThreads } = await import('../lib/platform.js')
const children = new Set()
after(() => { for (const child of children) child.kill('SIGKILL') })
const root = path.resolve(import.meta.dirname, '..')
function child(code, args = []) {
  const p = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { cwd: root, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(p)
  p.once('exit', () => children.delete(p))
  return p
}
function output(p) {
  return new Promise((resolve, reject) => {
    let error = ''
    p.stderr.on('data', d => error += d)
    p.once('error', reject)
    p.stdout.once('data', resolve)
    p.once('exit', () => reject(new Error(error || 'child exited before ready')))
  })
}

test('kernel lock excludes another process and is recoverable after SIGKILL', async () => {
  const name = `\0ccb-platform-${process.pid}`
  const dir = path.join(tmp, 'locks')
  const p = child(`import { acquireMutex } from './lib/platform.js'; await acquireMutex(${JSON.stringify(name)}, ${JSON.stringify(dir)}); console.log('ready');`)
  await output(p)
  await assert.rejects(acquireMutex(name, dir), e => e.code === 'EADDRINUSE')
  const exited = new Promise(r => p.once('exit', r))
  p.kill('SIGKILL')
  await exited
  const { withMutex } = await import('../lib/platform.js')
  await withMutex(name, dir, () => {}, 3000)
  if (process.platform === 'darwin') {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
    for (const file of fs.readdirSync(dir)) assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600)
  }
})

test('process argv preserves spaces and channel arguments without shell parsing', async () => {
  const args = ['argument with spaces', "quote'and\"double", '--channels=plugin:cc-bridge@cc-bridge']
  const p = child("console.log('ready'); setInterval(() => {}, 1000)", args)
  try {
    await output(p)
    assert.deepEqual(processInfo(p.pid).args.slice(-args.length), args)
    assert.equal(processInfo(p.pid).parent, process.pid)
  } finally { p.kill() }
})

test('thread ownership is checked against the specified process only', async () => {
  const thread = 'bbbbbbbb-1234-4321-abcd-abcdefabcdef'
  const p = child(`import fs from 'node:fs'; fs.openSync(${JSON.stringify(path.join(tmp, `rollout-now-${thread}.jsonl`))}, 'w'); console.log('ready'); setInterval(() => {}, 1000)`)
  try {
    await output(p)
    assert.ok(openRolloutThreads(p.pid).has(thread))
    assert.equal(openRolloutThreads(process.pid).has(thread), false)
  } finally { p.kill() }
})

test('macOS terminal handoff preserves argv and cwd while clearing session environment', () => {
  const dir = fs.mkdtempSync(path.join(tmp, "launch ' space-"))
  const file = path.join(dir, 'request.json')
  const result = path.join(tmp, 'terminal-result.json')
  const args = ['with spaces', "apostrophe'", '$(touch should-not-run)', '`false`']
  fs.writeFileSync(file, JSON.stringify({ cwd: tmp, env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'stale', CODEX_THREAD_ID: 'stale', CC_BRIDGE_LABEL: 'stale' }, argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(result)}, JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),claude:process.env.CLAUDE_CODE_SESSION_ID,codex:process.env.CODEX_THREAD_ID,label:process.env.CC_BRIDGE_LABEL}))`, ...args] }), { mode: 0o600 })
  const r = spawnSync(process.execPath, [path.join(root, 'bin/mac-terminal.js'), '--run', file], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(fs.readFileSync(result)), { argv: args, cwd: fs.realpathSync(tmp) })
  assert.equal(fs.existsSync(dir), false)
})

test('terminal shell command quotes executable and request paths', async () => {
  const { terminalShellCommand } = await import('../lib/mac-terminal.js')
  const request = "/tmp/with spaces/it's $(false) `false`.json"
  // printf substitutes for the node executable, letting the shell prove argv round-trips.
  const command = terminalShellCommand(request, '/usr/bin/printf')
  const r = spawnSync('/bin/sh', ['-c', command.replace("'/usr/bin/printf'", "'/usr/bin/printf' '%s\\n'")], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.stdout.trimEnd().split('\n').slice(-2), ['--run', request])
})

test('a symlinked data directory owned by this user is accepted', () => {
  const real = fs.mkdtempSync(path.join(tmp, 'real-data-'))
  const link = path.join(tmp, 'linked-data')
  fs.symlinkSync(real, link)
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "import { paths } from './lib/common.js'; console.log(paths.pairs())"],
    { cwd: root, env: { ...process.env, CC_BRIDGE_DATA_DIR: link }, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), path.join(link, 'pairs.json'))
})

test('the default macOS runtime directory is outside the /tmp cleaner', { skip: process.platform !== 'darwin' }, () => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'))
  const env = { ...process.env, HOME: home }
  delete env.CC_BRIDGE_RUNTIME_DIR
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "import { runtimeDir } from './lib/common.js'; console.log(runtimeDir())"],
    { cwd: root, env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), path.join(home, 'Library', 'Caches', 'cc-bridge'))
})

test('the macOS lock helper waits for a held lock in one process', { skip: process.platform !== 'darwin' }, async () => {
  const name = `\0ccb-wait-${process.pid}`
  const dir = path.join(tmp, 'wait-locks')
  const held = await acquireMutex(name, dir)
  setTimeout(() => held.close(), 300)
  const started = Date.now()
  const lock = await acquireMutex(name, dir, 3000)
  assert.ok(Date.now() - started >= 250)
  await new Promise(r => lock.close(r))
  const busy = await acquireMutex(name, dir)
  await assert.rejects(acquireMutex(name, dir, 100), e => e.code === 'EADDRINUSE')
  await new Promise(r => busy.close(r))
})

test('an unconsumed terminal launch request is removed after the handoff window', async () => {
  const { awaitHandoff } = await import('../lib/mac-terminal.js')
  const dir = fs.mkdtempSync(path.join(tmp, 'terminal-'))
  fs.writeFileSync(path.join(dir, 'request.json'), '{}', { mode: 0o600 })
  assert.equal(await awaitHandoff(dir, 200), false)
  assert.equal(fs.existsSync(dir), false)
  const consumed = fs.mkdtempSync(path.join(tmp, 'terminal-'))
  setTimeout(() => fs.rmSync(consumed, { recursive: true }), 100)
  assert.equal(await awaitHandoff(consumed, 5000), true)
})
