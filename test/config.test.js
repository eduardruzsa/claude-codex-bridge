// The config file: defaults, file values, env overrides, validation, and the places
// that read it from outside Node (claude-live) or before anything else works.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-config-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))
for (const k of Object.keys(process.env)) if (/^(CC_BRIDGE|CLAUDE|CODEX)/.test(k)) delete process.env[k]
const { SCHEMA, config, defaultsJson, initConfig, loadConfig, setConfig } = await import('../lib/config.js')
const { terminalCommand } = await import('../lib/launch.js')

let n = 0
// A fresh file per case, so the mtime cache never serves an older one.
function withConfig(contents) {
  const file = path.join(tmp, `config-${n++}.json`)
  if (contents !== undefined) fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents))
  process.env.CC_BRIDGE_CONFIG = file
  return file
}

test('defaults without a file; file values; env beats file', () => {
  withConfig()
  const d = loadConfig()
  assert.equal(d.exists, false)
  assert.equal(d.values.claude_bin, 'claude')
  assert.equal(d.values['plan_review.review_claude_plans'], false)
  assert.equal(d.values['plan_review.timeout_seconds'], 480)
  assert.deepEqual(JSON.parse(defaultsJson()).plan_review, { review_claude_plans: false, review_codex_plans: false, timeout_seconds: 480 })

  withConfig({ claude_bin: '/opt/claude', data_dir: '~/bridge', plan_review: { review_codex_plans: true }, max_exchange_depth: 5 })
  const f = loadConfig()
  assert.equal(f.values.claude_bin, '/opt/claude')
  assert.equal(f.sources.claude_bin, 'file')
  assert.equal(f.values.data_dir, path.join(os.homedir(), 'bridge'))
  assert.equal(config().plan_review.review_codex_plans, true)
  assert.equal(config().plan_review.review_claude_plans, false)
  assert.equal(config().max_exchange_depth, 5)

  const e = loadConfig({ CC_BRIDGE_CLAUDE_BIN: '/env/claude', CC_BRIDGE_PLAN_REVIEW: '0', CC_BRIDGE_LABEL: '' })
  assert.equal(e.values.claude_bin, '/env/claude')
  assert.equal(e.sources.claude_bin, 'env CC_BRIDGE_CLAUDE_BIN')
  assert.equal(e.values['plan_review.review_codex_plans'], false)
  assert.equal(e.values.default_label, 'claude', 'empty env var counts as unset')
})

test('invalid values name the key and where they came from; unknown keys warn', () => {
  withConfig('{ nope')
  assert.throws(() => loadConfig(), /is not valid JSON/)
  const file = withConfig({ plan_review: { timeout_seconds: 900 } })
  assert.throws(() => loadConfig(), new RegExp(`plan_review.timeout_seconds must be a whole number from 1 to 540 \\(from ${file}`))
  withConfig({ data_dir: 'relative/dir' })
  assert.throws(() => loadConfig(), /data_dir must be null or an absolute path/)
  withConfig({ default_label: 'has space' })
  assert.throws(() => loadConfig(), /default_label must be/)
  withConfig({ terminal: 'kitty' })
  assert.throws(() => loadConfig(), /terminal must be null or a non-empty array/)
  withConfig({})
  assert.throws(() => loadConfig({ CC_BRIDGE_PLAN_REVIEW: 'yes' }), /CC_BRIDGE_PLAN_REVIEW must be 0 or 1/)
  withConfig({ claude_bin: 'claude', colour: 'blue', plan_review: { review_claude_plans: true, extra: 1 } })
  assert.deepEqual(loadConfig().warnings.map(w => w.split(' in ')[0]), ['unknown key "colour"', 'unknown key "plan_review.extra"'])
})

test('terminal: argv from the file with placeholders, or a space-split env string', () => {
  withConfig({ terminal: ['kitty', '--directory', '{cwd}', '--title', '{title}', '--'] })
  assert.deepEqual(terminalCommand('/p', 'T'), ['kitty', '--directory', '/p', '--title', 'T', '--'])
  process.env.CC_BRIDGE_TERMINAL = 'foot -e'
  assert.deepEqual(terminalCommand('/p', 'T'), ['foot', '-e'])
  delete process.env.CC_BRIDGE_TERMINAL
  withConfig()
  assert.deepEqual(terminalCommand('/p', 'T'), ['xdg-terminal-exec', '--dir=/p', '--title=T'])
})

test('config init never overwrites; set validates and keeps other keys', () => {
  const file = withConfig()
  assert.equal(initConfig(), true)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), JSON.parse(defaultsJson()))
  assert.equal(initConfig(), false)
  setConfig('plan_review.review_claude_plans', 'true')
  setConfig('codex_bin', '/usr/local/bin/codex')
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.plan_review.review_claude_plans, true)
  assert.equal(saved.plan_review.timeout_seconds, 480)
  assert.equal(saved.codex_bin, '/usr/local/bin/codex')
  assert.throws(() => setConfig('plan_review.timeout_seconds', '9999'), /1 to 540/)
  assert.throws(() => setConfig('nope', '1'), /unknown key/)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).plan_review.timeout_seconds, 480, 'rejected value not written')
})

test('claude-live takes claude_bin from the config file', () => {
  const echo = path.join(tmp, 'echo-claude')
  fs.writeFileSync(echo, '#!/bin/sh\necho "configured $*"\n', { mode: 0o755 })
  const file = withConfig({ claude_bin: echo })
  // The real node first: a version-manager shim may not work with a different HOME.
  const env = { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, HOME: tmp, CC_BRIDGE_CONFIG: file }
  const run = bin => execFileSync(bin, ['--version'], { env, encoding: 'utf8' }).trim()
  assert.equal(run(path.join(root, 'bin', 'claude-live')), 'configured --version')
  // Through a symlink, as installed in ~/.local/bin.
  const link = path.join(tmp, 'claude-live')
  fs.symlinkSync(path.join(root, 'bin', 'claude-live'), link)
  assert.equal(run(link), 'configured --version')
})

test('a broken config file: the channel still starts and says why on every tool call', async () => {
  const file = withConfig('{ "claude_bin": ')
  const client = new Client({ name: 'config-test', version: '0' })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'claude-channel.js')],
    env: { PATH: process.env.PATH, HOME: tmp, CC_BRIDGE_CONFIG: file, CC_BRIDGE_ACTIVE: '1', CC_BRIDGE_CLAUDE_PROC: 'none', CLAUDE_CODE_SESSION_ID: 's' },
  }))
  try {
    const send = await client.callTool({ name: 'send_to_codex', arguments: { text: 'hi' } })
    assert.equal(send.isError, true)
    assert.match(send.content[0].text, /not listening: .*config-\d+\.json is not valid JSON/)
    const status = await client.callTool({ name: 'bridge_status', arguments: {} })
    assert.equal(status.isError, true)
    assert.match(status.content[0].text, /not valid JSON/)
  } finally {
    await client.close()
  }
})

test('a broken config file in a real plugin session: found via the claude process, still no crash', async () => {
  const file = withConfig('{ "runtime_dir": ')
  // A parent process named "claude" started with the channel flag, as Claude Code
  // would be; the channel finds it through /proc, so lifecycle lookup runs too.
  const fakeClaude = path.join(tmp, 'claude')
  fs.symlinkSync(process.execPath, fakeClaude)
  const wrapper = path.join(tmp, 'wrapper.cjs')
  fs.writeFileSync(wrapper, `const { spawn } = require('child_process')
const c = spawn(process.execPath.replace(/claude$/, 'node'), [${JSON.stringify(path.join(root, 'claude-channel.js'))}], { stdio: 'inherit' })
c.on('exit', code => process.exit(code ?? 1))`)
  fs.symlinkSync(process.execPath, path.join(tmp, 'node'))
  const client = new Client({ name: 'config-test', version: '0' })
  await client.connect(new StdioClientTransport({
    command: fakeClaude,
    args: [wrapper, '--dangerously-load-development-channels', 'plugin:cc-bridge@cc-bridge'],
    env: { PATH: process.env.PATH, HOME: tmp, CC_BRIDGE_CONFIG: file, CLAUDE_CODE_SESSION_ID: 's' },
  }))
  try {
    const send = await client.callTool({ name: 'send_to_codex', arguments: { text: 'hi' } })
    assert.equal(send.isError, true)
    assert.match(send.content[0].text, /not listening: .*is not valid JSON/)
  } finally {
    await client.close()
  }
})

test('concurrent config init and set lose nothing', async () => {
  const file = withConfig()
  const sets = [['claude_bin', '/a/claude'], ['codex_bin', '/b/codex'], ['max_exchange_depth', '7'], ['start_timeout_seconds', '99'], ['consult_timeout_seconds', '77']]
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'bin', 'cc-bridge'), 'config', ...args], { env: { ...process.env, CC_BRIDGE_CONFIG: file }, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', d => (err += d))
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(err))))
  })
  await Promise.all([run(['init']), ...sets.map(([k, v]) => run(['set', k, v])), run(['init'])])
  const values = loadConfig().values
  for (const [k, v] of sets) assert.equal(String(values[k]), v, k)
  assert.ok(!fs.existsSync(`${file}.lock`))
})

test('every documented key is in config.example.json; versions agree', () => {
  const example = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'))
  const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? flat(v, `${p}${k}.`) : [`${p}${k}`]))
  assert.deepEqual(flat(example).sort(), Object.keys(SCHEMA).sort())
  const read = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'))
  assert.equal(read('.claude-plugin/plugin.json').version, read('package.json').version)
})
