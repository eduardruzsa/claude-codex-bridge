import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync, execFileSync } from 'node:child_process'
import { after, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { install, minimumNode, supportedNode, root, shQuote, uninstall } from '../lib/admin.js'
import { transition } from '../lib/lifecycle.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-ux-'))
process.env.CC_BRIDGE_RUNTIME_DIR = path.join(tmp, 'run')
process.env.CC_BRIDGE_DATA_DIR = path.join(tmp, 'data')
process.env.CC_BRIDGE_CLAUDE_PROC = 'none' // isolate from the Claude session running the tests
process.env.CC_BRIDGE_CONFIG = path.join(tmp, 'cc-bridge.json') // never the user's config
const terminal = path.join(tmp, 'fake-terminal') // CI has no xdg-terminal-exec
fs.writeFileSync(terminal, '#!/bin/sh\n', { mode: 0o755 })
process.env.CC_BRIDGE_TERMINAL = terminal
fs.mkdirSync(process.env.CC_BRIDGE_DATA_DIR, { mode: 0o700 })
const fake = path.join(tmp, 'fake-agent')
const config = path.join(tmp, 'config.json')
fs.writeFileSync(config, JSON.stringify({ other: { command: 'preserve-me' } }))
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('fs');const p=${JSON.stringify(config)};const a=process.argv.slice(2);
if(a[0]==='mcp') {
 const c=JSON.parse(fs.readFileSync(p));
 if(a[1]==='get') {if(!c[a[2]]){console.error('No MCP server named '+a[2]);process.exit(1)}console.log(JSON.stringify(c[a[2]]))}
 if(a[1]==='add') {c[a[2]]={enabled:true,transport:{command:a[4],args:a.slice(5)}};fs.writeFileSync(p,JSON.stringify(c))}
 if(a[1]==='remove') {delete c[a[2]];fs.writeFileSync(p,JSON.stringify(c))}
} else console.log('--thread --message --restricted Claude Code 2.1.280');
`, { mode: 0o755 })
process.env.CC_BRIDGE_CODEX_BIN = fake
process.env.CC_BRIDGE_CLAUDE_BIN = fake
const { connectClaude, listSessions, projectDir } = await import('../lib/discovery.js')
const { pairLive, unpair } = await import('../lib/common.js')
const T = '11111111-2222-3333-4444-555555555555'
const U = '99999999-2222-3333-4444-555555555555'
const clients = new Set()
after(async () => {
  for (const c of clients) await c.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function channel(label, cwd, lifecycle) {
  const client = new Client({ name: 'ux-test', version: '1' })
  const notifications = []
  client.fallbackNotificationHandler = async n => notifications.push(n)
  clients.add(client)
  const env = { ...process.env, CC_BRIDGE_LABEL: label, CLAUDE_CODE_SESSION_ID: `${label}-session`, CC_BRIDGE_ACTIVE: '1' }
  delete env.CC_BRIDGE_LIFECYCLE_DIR
  if (lifecycle) env.CC_BRIDGE_LIFECYCLE_DIR = lifecycle
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'claude-channel.js')], cwd, env }))
  const deadline = Date.now() + 3000
  while (!fs.existsSync(path.join(process.env.CC_BRIDGE_RUNTIME_DIR, `claude-${label}.sock`))) {
    assert.ok(Date.now() < deadline, 'channel did not bind')
    await new Promise(r => setTimeout(r, 10))
  }
  return { client, notifications }
}
async function close(c) { await c.client.close(); clients.delete(c.client) }
function hook(dir, sid, event, source = 'startup', cwd = tmp) {
  const run = spawnSync(process.execPath, [path.join(root, 'bin/lifecycle-hook.js'), dir], {
    input: JSON.stringify({ session_id: sid, hook_event_name: event, source, cwd }), encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr)
}

test('installer is repeatable, preserves other servers and rejects conflicts before changing links', () => {
  const home = path.join(tmp, 'home')
  const hooksFile = path.join(home, '.codex', 'hooks.json')
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true })
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep-me' }] }] } }))
  fs.writeFileSync(process.env.CC_BRIDGE_CONFIG, JSON.stringify({ plan_review: { review_codex_plans: true } }))
  install({ home })
  const first = fs.readFileSync(config, 'utf8')
  install({ home })
  assert.equal(fs.readFileSync(config, 'utf8'), first)
  // The Codex plan-review Stop hook is added once and other hooks are kept.
  const stop = JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks.Stop.flatMap(g => g.hooks.map(h => h.command))
  assert.equal(stop.length, 2)
  assert.equal(stop[0], 'keep-me')
  assert.match(stop[1], /bin\/plan-review' --codex$/)
  // Reinstalling after a quoting change replaces the old entry instead of adding one.
  const legacy = JSON.parse(fs.readFileSync(hooksFile, 'utf8'))
  legacy.hooks.Stop[1].hooks[0].command = '"/usr/bin/node" "/old/checkout/bin/plan-review" --codex'
  fs.writeFileSync(hooksFile, JSON.stringify(legacy))
  install({ home })
  assert.equal(JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks.Stop.flatMap(g => g.hooks).length, 2)
  // Turning Codex plan review off and reinstalling removes only our hook.
  fs.writeFileSync(process.env.CC_BRIDGE_CONFIG, JSON.stringify({ plan_review: { review_codex_plans: false } }))
  install({ home })
  assert.deepEqual(JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks.Stop.flatMap(g => g.hooks.map(h => h.command)), ['keep-me'])
  assert.equal(JSON.parse(first).other.command, 'preserve-me')
  assert.equal(fs.readlinkSync(path.join(home, '.local/bin/claude-live')), path.join(root, 'bin/claude-live'))
  const conflictingHome = path.join(tmp, 'conflict')
  fs.mkdirSync(path.join(conflictingHome, '.local/bin'), { recursive: true })
  fs.writeFileSync(path.join(conflictingHome, '.local/bin/claude-live'), 'valuable')
  assert.throws(() => install({ home: conflictingHome }), /Refusing to overwrite/)
  assert.equal(fs.existsSync(path.join(conflictingHome, '.local/bin/cc-bridge')), false)
  const original = JSON.parse(first)
  fs.writeFileSync(config, JSON.stringify({ ...original, 'cc-bridge': { command: '/unrelated' } }))
  assert.throws(() => install({ home }), /Conflicting cc-bridge/)
  assert.equal(JSON.parse(fs.readFileSync(config)).other.command, 'preserve-me')
  fs.writeFileSync(config, first)
  assert.ok(supportedNode(minimumNode))
  assert.ok(!supportedNode('22.23.1'))
})

test('uninstall removes only what is ours; --purge spares unrelated files', () => {
  const home = path.join(tmp, 'uninstall-home')
  const hooksFile = path.join(home, '.codex', 'hooks.json')
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true })
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep-me' }] }] } }))
  fs.writeFileSync(process.env.CC_BRIDGE_CONFIG, JSON.stringify({ plan_review: { review_codex_plans: true } }))
  install({ home })
  const data = process.env.CC_BRIDGE_DATA_DIR
  fs.writeFileSync(path.join(data, 'token'), 'x')
  fs.writeFileSync(path.join(data, 'mine.txt'), 'not the bridge\'s')

  const kept = uninstall({ home })
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8'))['cc-bridge'], undefined, 'MCP registration removed')
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).other.command, 'preserve-me')
  assert.deepEqual(JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks.Stop.flatMap(g => g.hooks.map(h => h.command)), ['keep-me'])
  assert.equal(fs.existsSync(path.join(home, '.local/bin/claude-live')), false)
  assert.ok(fs.existsSync(path.join(data, 'token')), 'data kept without --purge')
  assert.match(kept.done.join('\n'), /use --purge/)

  // A foreign file where our link would be is left alone.
  fs.writeFileSync(path.join(home, '.local/bin/cc-bridge'), 'valuable')
  const purged = uninstall({ home, purge: true })
  assert.equal(fs.readFileSync(path.join(home, '.local/bin/cc-bridge'), 'utf8'), 'valuable')
  assert.match(purged.skipped.join('\n'), /not our link/)
  assert.ok(!fs.existsSync(path.join(data, 'token')))
  assert.equal(fs.readFileSync(path.join(data, 'mine.txt'), 'utf8'), 'not the bridge\'s')
  assert.ok(!fs.existsSync(process.env.CC_BRIDGE_CONFIG))
})

test('claude-live enables the plugin channel and forwards arguments', () => {
  const echo = path.join(tmp, 'echo-args')
  fs.writeFileSync(echo, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
  const out = execFileSync(path.join(root, 'bin', 'claude-live'), ['--resume', "it's"], { env: { ...process.env, CC_BRIDGE_CLAUDE_BIN: echo }, encoding: 'utf8' })
  assert.deepEqual(out.trim().split('\n'), ['--dangerously-load-development-channels', 'plugin:cc-bridge@cc-bridge', '--resume', "it's"])
  // Aliased as `claude`: subcommands and --version pass through without the channel flag.
  for (const args of [['mcp', 'list'], ['update'], ['--version'], ['plugin', 'list']]) {
    const plain = execFileSync(path.join(root, 'bin', 'claude-live'), args, { env: { ...process.env, CC_BRIDGE_CLAUDE_BIN: echo }, encoding: 'utf8' })
    assert.deepEqual(plain.trim().split('\n'), args)
  }
})

test('plugin manifests wire the channel server and lifecycle hooks', () => {
  const read = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'))
  assert.equal(read('.claude-plugin/plugin.json').name, 'cc-bridge')
  const market = read('.claude-plugin/marketplace.json')
  assert.equal(market.name, 'cc-bridge')
  assert.deepEqual(market.plugins.map(p => [p.name, p.source]), [['cc-bridge', './']])
  assert.deepEqual(read('.mcp.json').mcpServers['cc-bridge'].args, ['${CLAUDE_PLUGIN_ROOT}/bin/plugin-start'])
  for (const event of ['SessionStart', 'SessionEnd']) {
    assert.match(read('hooks/hooks.json').hooks[event][0].hooks[0].command, /lifecycle-hook\.js" --plugin$/)
  }
})

test('plugin-mode hook is a no-op outside channel sessions', () => {
  const before = fs.existsSync(process.env.CC_BRIDGE_RUNTIME_DIR) ? fs.readdirSync(process.env.CC_BRIDGE_RUNTIME_DIR) : []
  const run = spawnSync(process.execPath, [path.join(root, 'bin/lifecycle-hook.js'), '--plugin'], {
    input: JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart', source: 'startup', cwd: tmp }), encoding: 'utf8',
    env: { ...process.env, CC_BRIDGE_ACTIVE: '' },
  })
  assert.equal(run.status, 0, run.stderr)
  const after = fs.existsSync(process.env.CC_BRIDGE_RUNTIME_DIR) ? fs.readdirSync(process.env.CC_BRIDGE_RUNTIME_DIR) : []
  assert.deepEqual(after.filter(f => f.startsWith('proc-')), before.filter(f => f.startsWith('proc-')))
})

test('project matching canonicalizes nested/symlink paths and keeps worktrees separate', () => {
  const repo = path.join(tmp, 'project'), worktree = path.join(tmp, 'worktree')
  fs.mkdirSync(repo)
  const git = args => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
  git(['init']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'test'])
  git(['worktree', 'add', '--detach', worktree])
  try {
    fs.mkdirSync(path.join(repo, 'nested'))
    fs.symlinkSync(repo, path.join(tmp, 'alias'))
    assert.equal(projectDir(path.join(repo, 'nested')), repo)
    assert.equal(projectDir(path.join(tmp, 'alias')), repo)
    assert.equal(projectDir(worktree), worktree)
    assert.notEqual(projectDir(worktree), projectDir(repo))
    // No modifications or untracked/ignored files exist in this temporary worktree.
    assert.equal(execFileSync('git', ['-C', worktree, 'status', '--porcelain', '--ignored'], { encoding: 'utf8' }), '')
  } finally { git(['worktree', 'remove', worktree]) }
})

test('discovery auto-connects only one eligible same-project conversation', async () => {
  const cwd = path.join(tmp, 'discovery'); fs.mkdirSync(cwd)
  await assert.rejects(connectClaude(T, cwd), /No unpaired/)
  const a = await channel('discover-a', cwd)
  assert.equal((await listSessions()).find(s => s.label === 'discover-a').state, 'available')
  assert.equal((await connectClaude(T, cwd)).label, 'discover-a')
  assert.equal((await connectClaude(T, cwd)).pair.codex, T)
  await assert.rejects(connectClaude(U, cwd), /No unpaired/)
  await unpair('discover-a')
  const b = await channel('discover-b', cwd)
  await assert.rejects(connectClaude(T, cwd), /Several Claude/)
  assert.equal((await connectClaude(T, cwd, 'discover-b')).label, 'discover-b')
  await close(b)
  await assert.rejects(connectClaude(T, cwd), /Existing pairing.*not switching/)
  await unpair('discover-b'); await close(a)
})

test('lifecycle rejects delayed events and allows same-conversation resume', () => {
  const start = (sid, source = 'startup') => ({ session_id: sid, hook_event_name: 'SessionStart', source, cwd: tmp })
  let s = transition(null, start('A'), '10')
  s = transition(s, { session_id: 'A', hook_event_name: 'SessionEnd' }, '20')
  assert.equal(s.ready, false)
  assert.deepEqual(transition(s, start('A'), '15'), s)
  assert.deepEqual(transition(s, start('A'), '25'), s)
  s = transition(s, start('B', 'clear'), '30')
  assert.equal(transition(s, { session_id: 'A', hook_event_name: 'SessionEnd' }, '35').ready, true)
  assert.equal(transition(s, start('A', 'resume'), '40').session, 'A')
})

test('running channel refreshes lifecycle identity; changed conversations cannot inherit pairing or replies', async () => {
  const dir = path.join(tmp, 'lifecycle'); fs.mkdirSync(dir, { mode: 0o700 })
  const cwd = path.join(tmp, 'lifecycle-project'); fs.mkdirSync(cwd)
  const c = await channel('lifecycle', cwd, dir)
  const { sendToClaudeSocket } = await import('../lib/common.js')
  const { deliverToClaude } = await import('../lib/deliver.js')
  assert.equal((await sendToClaudeSocket('lifecycle', { op: 'ping' })).status, 'transitioning')
  hook(dir, 'A', 'SessionStart', 'startup', cwd)
  await pairLive('lifecycle', T)
  const sent = await deliverToClaude({ fromThread: T, label: 'lifecycle', claudeSession: 'A', text: 'before clear' })
  assert.equal(sent.status, 'delivered')
  hook(dir, 'A', 'SessionEnd', 'clear', cwd)
  assert.equal((await sendToClaudeSocket('lifecycle', { op: 'ping' })).status, 'transitioning')
  hook(dir, 'B', 'SessionStart', 'clear', cwd)
  assert.equal((await listSessions()).find(s => s.label === 'lifecycle').state, 'conversation-changed')
  await assert.rejects(connectClaude(T, cwd), /Existing pairing/)
  const late = await deliverToClaude({ fromThread: T, label: 'lifecycle', claudeSession: 'A', text: 'old message' })
  assert.equal(late.status, 'session_changed')
  await connectClaude(T, cwd, 'lifecycle')
  const reply = await c.client.callTool({ name: 'reply', arguments: { msg_id: sent.msg_id, text: 'wrong conversation' } })
  assert.equal(reply.isError, true)
  hook(dir, 'B', 'SessionEnd', 'resume', cwd)
  hook(dir, 'B', 'SessionStart', 'resume', cwd)
  assert.equal((await connectClaude(T, cwd)).pair.claude_session, 'B')
  await unpair('lifecycle'); await close(c)
})

test('hook commands are single-quoted so nothing in a path is expanded', () => {
  const nasty = "/tmp/a $(printf EXPANDED) `printf TICK` $HOME it's"
  assert.equal(execFileSync('sh', ['-c', `printf %s ${shQuote(nasty)}`], { encoding: 'utf8' }), nasty)
})
