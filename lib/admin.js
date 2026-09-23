import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dataDir, runtimeDir } from './common.js'
import { config, configPath, loadConfig } from './config.js'
import { terminalCommand } from './launch.js'
import { version } from './version.js'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const minimumNode = '22.23.2'
export function supportedNode(nodeVersion = process.versions.node) {
  const a = nodeVersion.split('.').map(Number), b = minimumNode.split('.').map(Number)
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i] }
  return true
}
function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024 })
}
const codex = () => config().codex_bin
const claude = () => config().claude_bin

// An executable on PATH (or at a path), without running it.
function executable(cmd) {
  const candidates = cmd.includes('/') ? [cmd] : (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(d => path.join(d, cmd))
  return candidates.some(f => {
    try {
      fs.accessSync(f, fs.constants.X_OK)
      return fs.statSync(f).isFile()
    } catch {
      return false
    }
  })
}

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
  ]) {
    const r = run(cmd, args)
    add(name, r.status === 0 && pattern.test(r.stdout || ''), fix)
  }
  const terminal = terminalCommand()[0]
  add(`Terminal launcher (${terminal})`, executable(terminal),
    `Install ${terminal}, or set "terminal" in ${configPath()}, so a missing agent can be started.`)
  // The development-channel flag is hidden from some CLI help versions.
  const devFlag = run(claude(), ['--dangerously-load-development-channels', 'server:cc-bridge', '--version'])
  add('Claude development-channel flag', devFlag.status === 0, 'Update Claude Code to a version supporting development Channels.')
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

// Codex Stop hook that sends a <proposed_plan> to Claude for review. Merged into
// ~/.codex/hooks.json; other hooks are kept.
export function codexHooksFile(home = os.homedir()) {
  return path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'hooks.json')
}
// POSIX single-quoting: nothing inside is expanded ($(), backticks, $VAR).
export const shQuote = s => `'${String(s).replaceAll("'", `'\\''`)}'`
const planHookCommand = () => `${shQuote(process.execPath)} ${shQuote(path.join(root, 'bin', 'plan-review'))} --codex`
export function codexPlanHookInstalled(home = os.homedir()) {
  try {
    const stop = JSON.parse(fs.readFileSync(codexHooksFile(home), 'utf8')).hooks?.Stop || []
    return stop.some(g => (g.hooks || []).some(h => h.command === planHookCommand()))
  } catch {
    return false
  }
}
// Adds our Stop hook (add = true) or only removes it. Any older cc-bridge plan hook
// (e.g. from a moved checkout) is dropped; other hooks are kept. Returns whether the
// file changed.
function setCodexPlanHook(home, add) {
  const file = codexHooksFile(home)
  let hooks = { hooks: {} }
  let exists = true
  try {
    hooks = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Cannot read ${file}: ${e.message}. It was not changed.`)
    exists = false
  }
  if (!exists && !add) return false
  hooks.hooks ||= {}
  const before = JSON.stringify(hooks)
  const stop = (hooks.hooks.Stop || [])
    .map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !/plan-review["']? --codex$/.test(h.command || '')) }))
    .filter(g => g.hooks.length)
  if (add) stop.push({ hooks: [{ type: 'command', command: planHookCommand(), timeout: 600 }] })
  if (stop.length) hooks.hooks.Stop = stop
  else delete hooks.hooks.Stop
  if (JSON.stringify(hooks) === before) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(hooks, null, 2) + '\n')
  fs.renameSync(tmp, file)
  return true
}

// Hook trust as Codex itself reports it (app-server hooks/list): trusted, untrusted,
// modified, managed, missing, or unknown if Codex couldn't be asked.
export function codexPlanHookTrust(timeoutMs = 15000) {
  return new Promise(resolve => {
    const p = spawn(codex(), ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = ''
    const done = v => {
      clearTimeout(timer)
      p.kill()
      resolve(v)
    }
    const timer = setTimeout(() => done('unknown'), timeoutMs)
    const send = m => p.stdin.write(JSON.stringify(m) + '\n')
    p.on('error', () => done('unknown'))
    p.stdout.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        let m
        try {
          m = JSON.parse(buf.slice(0, i))
        } catch {
          m = {}
        }
        buf = buf.slice(i + 1)
        if (m.id === 1) {
          send({ method: 'initialized' })
          send({ id: 2, method: 'hooks/list', params: { cwds: [os.homedir()] } })
        } else if (m.id === 2) {
          const hooks = (m.result?.data || []).flatMap(e => e.hooks || [])
          const ours = hooks.find(h => h.eventName === 'stop' && h.command === planHookCommand())
          done(m.error ? 'unknown' : ours ? ours.trustStatus : 'missing')
        }
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'cc-bridge-doctor', version } } })
  })
}

export function install({ home = os.homedir() } = {}) {
  const reviewCodex = config().plan_review.review_codex_plans
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
  setCodexPlanHook(home, reviewCodex)
  return 'Installed. Restart Codex once. Start Claude with claude-live, then ask either agent to talk to the other.' +
    (reviewCodex
      ? '\nCodex plan review is on: trust the new cc-bridge hook when Codex asks (or run /hooks); Codex skips hooks until you review them.'
      : `\nPlan review is off. To turn it on, see ${configPath()} (cc-bridge config).`)
}

// Files and directories the bridge creates in its data and runtime directories.
// --purge deletes only these, so a custom data_dir or runtime_dir shared with other
// files is safe; the directory itself goes only if it ends up empty.
const OWNED = [/^token$/, /^pairs\.json$/, /^transcript\.jsonl$/, /^consultations\.json$/, /^pending-(codex|claude)$/,
  /^plan-review$/, /^claude-[A-Za-z0-9_-]{1,40}\.sock$/, /^proc-\d+-\d+$/, /^doctor-\d+\.sock$/, /\.\d+\.tmp$/]
function purgeDir(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  const removed = entries.filter(name => OWNED.some(re => re.test(name)))
  for (const name of removed) fs.rmSync(path.join(dir, name), { recursive: true, force: true })
  try {
    fs.rmdirSync(dir)
  } catch {}
  return removed.map(name => path.join(dir, name))
}

// Reverse of install(). Removes only what is recognisably ours; anything else is
// reported and left alone. --purge also removes bridge data, sockets and the config.
export function uninstall({ home = os.homedir(), purge = false } = {}) {
  const done = []
  const skipped = []
  const entry = (() => {
    try {
      return registration()
    } catch (e) {
      skipped.push(e.message)
      return undefined
    }
  })()
  if (entry && matchesRegistration(entry)) {
    const r = run(codex(), ['mcp', 'remove', 'cc-bridge'])
    if (r.status === 0) done.push('removed the Codex MCP server cc-bridge')
    else skipped.push(`codex mcp remove cc-bridge failed: ${(r.stderr || r.stdout || '').trim()}`)
  } else if (entry) skipped.push('Codex MCP server cc-bridge points elsewhere; left alone')
  if (setCodexPlanHook(home, false)) done.push(`removed the plan-review hook from ${codexHooksFile(home)}`)
  if (pluginInstalled()) {
    const r = run(claude(), ['plugin', 'uninstall', PLUGIN])
    if (r.status === 0) done.push(`uninstalled the Claude plugin ${PLUGIN}`)
    else skipped.push(`claude plugin uninstall ${PLUGIN} failed: ${(r.stderr || r.stdout || '').trim()}`)
  }
  const market = run(claude(), ['plugin', 'marketplace', 'remove', 'cc-bridge'])
  if (market.status === 0) done.push('removed the cc-bridge Claude marketplace')
  for (const name of ['cc-bridge', 'claude-live']) {
    const target = path.join(root, 'bin', name), link = path.join(home, '.local', 'bin', name)
    try {
      if (fs.lstatSync(link).isSymbolicLink() && path.resolve(path.dirname(link), fs.readlinkSync(link)) === target) {
        fs.unlinkSync(link)
        done.push(`removed ${link}`)
      } else skipped.push(`${link} is not our link; left alone`)
    } catch (e) {
      if (e.code !== 'ENOENT') skipped.push(`${link}: ${e.message}`)
    }
  }
  if (purge) {
    for (const f of [...purgeDir(dataDir()), ...purgeDir(runtimeDir())]) done.push(`deleted ${f}`)
    if (fs.existsSync(configPath())) {
      fs.rmSync(configPath())
      done.push(`deleted ${configPath()}`)
      try {
        fs.rmdirSync(path.dirname(configPath()))
      } catch {}
    }
  } else done.push(`kept ${dataDir()} and ${configPath()} (use --purge to delete them)`)
  return { done, skipped }
}
export async function doctor() {
  const checks = []
  try {
    const { file, exists, warnings } = loadConfig()
    checks.push({ name: `Config ${exists ? file : '(defaults; no file)'}`, ok: true })
    for (const w of warnings) checks.push({ name: 'Config', ok: false, fix: `Remove or fix ${w}` })
  } catch (e) {
    // Every other check needs the config; report this one only.
    return [{ name: 'Config', ok: false, fix: e.message }]
  }
  checks.push(...capabilityChecks())
  const reviewCodex = config().plan_review.review_codex_plans
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
  if (reviewCodex) {
    checks.push({ name: 'Codex plan-review hook', ok: codexPlanHookInstalled(),
      fix: 'plan_review.review_codex_plans is on but the hook is missing. Run: cc-bridge install' })
    const trust = await codexPlanHookTrust()
    checks.push({ name: 'Codex plan-review hook trusted', ok: trust === 'trusted',
      fix: trust === 'unknown'
        ? 'Could not ask Codex (codex app-server hooks/list); open Codex and check /hooks.'
        : `Codex reports it as ${trust}; it won't run until you open Codex, run /hooks and trust the cc-bridge Stop hook.` })
  } else if (codexPlanHookInstalled()) {
    checks.push({ name: 'Codex plan-review hook', ok: false,
      fix: 'Installed although plan_review.review_codex_plans is off (it does nothing). Run: cc-bridge install to remove it' })
  }
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
