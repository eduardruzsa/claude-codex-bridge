import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runtimeDir } from './common.js'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const minimumNode = '22.23.2'
export function supportedNode(version = process.versions.node) {
  const a = version.split('.').map(Number), b = minimumNode.split('.').map(Number)
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i] }
  return true
}
function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024 })
}
const codex = () => process.env.CC_BRIDGE_CODEX_BIN || 'codex'
const claude = () => process.env.CC_BRIDGE_CLAUDE_BIN || 'claude'

export function capabilityChecks() {
  const checks = []
  const add = (name, ok, fix) => checks.push({ name, ok, fix })
  add('Linux', process.platform === 'linux', 'Use a Linux host; this bridge uses /proc and abstract sockets.')
  add(`Node >= ${minimumNode}`, supportedNode(), `Install Node ${minimumNode} or newer.`)
  for (const [name, cmd, args, pattern, fix] of [
    ['Codex queue', codex(), ['queue', '--help'], /--thread[\s\S]*--message/, 'Update Codex to a version providing codex queue.'],
    ['Claude restricted consultations', claude(), ['--help'], /--restricted/, 'Update Claude Code to a version providing --restricted and Channels.'],
    ['flock', 'flock', ['--version'], /flock/, 'Install util-linux (flock).'],
    ['Git project discovery', 'git', ['--version'], /git version/, 'Install git.'],
    ['Terminal launcher', 'xdg-terminal-exec', ['--help'], /xdg-terminal-exec/, 'Install xdg-terminal-exec, or set CC_BRIDGE_TERMINAL, so a missing agent can be started.'],
  ]) {
    const r = run(cmd, args)
    add(name, r.status === 0 && pattern.test(r.stdout || ''), fix)
  }
  // The development-channel flag is hidden from some CLI help versions.
  const version = run(claude(), ['--dangerously-load-development-channels', 'server:cc-bridge', '--version'])
  add('Claude development-channel flag', version.status === 0, 'Update Claude Code to a version supporting development Channels.')
  return checks
}

export function registration() {
  const r = run(codex(), ['mcp', 'get', 'cc-bridge', '--json'])
  if (r.status !== 0) {
    if (/No MCP server|not found/i.test(r.stderr || '')) return null
    throw new Error(`Cannot inspect Codex MCP registration: ${(r.stderr || r.error?.message || 'command failed').trim()}`)
  }
  return JSON.parse(r.stdout)
}
export function matchesRegistration(entry) {
  const t = entry?.transport || entry
  return entry?.enabled !== false && (t?.command === 'node' || t?.command === process.execPath)
    && t?.args?.length === 1 && path.resolve(t.args[0]) === path.join(root, 'codex-mcp.js')
}
export function linkPlan(home = os.homedir()) {
  return ['cc-bridge', 'claude-live'].map(name => {
    const target = path.join(root, 'bin', name), link = path.join(home, '.local', 'bin', name)
    let exists = false
    try {
      exists = true
      if (!fs.lstatSync(link).isSymbolicLink() || path.resolve(path.dirname(link), fs.readlinkSync(link)) !== target) {
        throw new Error(`Refusing to overwrite ${link}; move the unrelated file/link before installing.`)
      }
    } catch (e) { if (e.code === 'ENOENT') exists = false; else throw e }
    return { target, link, exists }
  })
}
export const PLUGIN = 'cc-bridge@cc-bridge'

export function pluginInstalled() {
  const r = run(claude(), ['plugin', 'list', '--json'])
  try {
    const list = JSON.parse(r.stdout)
    return (Array.isArray(list) ? list : list.plugins || []).some(p => (p.id || p.name) === PLUGIN)
  } catch {
    return false
  }
}

// Adds this repo as the local "cc-bridge" marketplace and installs (or updates) the
// Claude plugin from it. Idempotent.
function installPlugin() {
  const add = run(claude(), ['plugin', 'marketplace', 'add', root])
  if (add.status !== 0 && !/already/i.test((add.stderr || '') + (add.stdout || ''))) {
    throw new Error(`Adding the cc-bridge marketplace failed: ${(add.stderr || add.stdout || '').trim()}`)
  }
  run(claude(), ['plugin', 'marketplace', 'update', 'cc-bridge'])
  const step = pluginInstalled() ? ['update', PLUGIN] : ['install', PLUGIN]
  const r = run(claude(), ['plugin', ...step])
  if (r.status !== 0) throw new Error(`claude plugin ${step.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`)
}

export function install({ home = os.homedir() } = {}) {
  const failures = capabilityChecks().filter(c => !c.ok)
  if (failures.length) throw new Error(failures.map(c => `${c.name}: ${c.fix}`).join('\n'))
  const links = linkPlan(home)
  const entry = registration()
  if (entry && !matchesRegistration(entry)) throw new Error('Conflicting cc-bridge MCP registration. Inspect with: codex mcp get cc-bridge --json. It was not changed.')
  if (!entry) {
    const r = run(codex(), ['mcp', 'add', 'cc-bridge', '--', process.execPath, path.join(root, 'codex-mcp.js')])
    if (r.status !== 0) throw new Error(`MCP registration failed: ${(r.stderr || r.error?.message || '').trim()}`)
  }
  for (const { target, link, exists } of links) {
    fs.mkdirSync(path.dirname(link), { recursive: true })
    if (!exists) fs.symlinkSync(target, link)
  }
  installPlugin()
  return 'Installed. Restart Codex once. Start Claude with claude-live, then ask either agent to talk to the other.'
}
export async function doctor() {
  const checks = capabilityChecks()
  for (const [name, cmd, args, accepts, fix] of [
    ['Claude login', claude(), ['auth', 'status', '--json'], s => JSON.parse(s).loggedIn === true, 'Run: claude auth login'],
    ['Codex login', codex(), ['login', 'status'], s => /logged in/i.test(s), 'Run: codex login'],
  ]) {
    const r = run(cmd, args)
    let ok = false
    try { ok = r.status === 0 && accepts((r.stdout || '') + (r.stderr || '')) } catch {}
    checks.push({ name, ok, fix })
  }
  checks.push({ name: `Claude plugin ${PLUGIN}`, ok: pluginInstalled(), fix: 'Run: cc-bridge install' })
  try {
    checks.push({ name: 'Codex MCP registration', ok: matchesRegistration(registration()), fix: 'Run: cc-bridge install (or node bin/cc-bridge install from the repository).' })
  } catch (e) { checks.push({ name: 'Codex MCP registration', ok: false, fix: e.message }) }
  try {
    for (const p of linkPlan()) checks.push({ name: path.basename(p.link), ok: p.exists, fix: 'Run: node bin/cc-bridge install' })
  } catch (e) { checks.push({ name: 'Command links', ok: false, fix: e.message }) }
  checks.push({ name: '~/.local/bin on PATH', ok: (process.env.PATH || '').split(path.delimiter).includes(path.join(os.homedir(), '.local', 'bin')), fix: 'Add ~/.local/bin to PATH, then reopen your terminal.' })
  const socket = path.join(runtimeDir(), `doctor-${process.pid}.sock`)
  const server = net.createServer(c => c.destroy())
  try {
    fs.mkdirSync(runtimeDir(), { recursive: true, mode: 0o700 })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
    checks.push({ name: 'Local socket access', ok: true })
  } catch (e) { checks.push({ name: 'Local socket access', ok: false, fix: `Check runtime directory permissions/sandbox: ${e.message}` }) }
  finally { if (server.listening) await new Promise(r => server.close(r)) }
  return checks
}
