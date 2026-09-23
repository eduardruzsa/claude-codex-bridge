#!/usr/bin/env node
// Settings: ~/.config/cc-bridge/config.json, each key overridable by its CC_BRIDGE_*
// environment variable (env > file > default). A fixed path, not $XDG_CONFIG_HOME:
// Codex strips environment from MCP servers and the Claude plugin runs from a copy,
// so the file is what every side reliably sees. Re-read when it changes.
// No imports from the rest of the bridge: everything else depends on this.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Hooks get 600 s; the reviewer needs room for setup and a bounded shutdown.
export const MAX_REVIEW_SECONDS = 540

// Flat keys; dots are nesting in the file. `env` values are strings; an empty one
// counts as unset.
export const SCHEMA = {
  claude_bin: { type: 'string', default: 'claude', env: 'CC_BRIDGE_CLAUDE_BIN', doc: 'Claude Code command' },
  codex_bin: { type: 'string', default: 'codex', env: 'CC_BRIDGE_CODEX_BIN', doc: 'Codex command' },
  terminal: { type: 'argv', default: null, env: 'CC_BRIDGE_TERMINAL', doc: 'Terminal that opens a missing agent, as argv; {cwd} and {title} are replaced. null: xdg-terminal-exec' },
  default_label: { type: 'label', default: 'claude', env: 'CC_BRIDGE_LABEL', doc: 'Session label of claude-live' },
  data_dir: { type: 'path', default: null, env: 'CC_BRIDGE_DATA_DIR', doc: 'Pairings, transcript, token. null: ~/.local/share/cc-bridge' },
  runtime_dir: { type: 'path', default: null, env: 'CC_BRIDGE_RUNTIME_DIR', doc: 'Sockets and launch state. null: $XDG_RUNTIME_DIR/cc-bridge' },
  'plan_review.review_claude_plans': { type: 'boolean', default: false, env: 'CC_BRIDGE_PLAN_REVIEW', doc: 'Codex reviews Claude plans' },
  'plan_review.review_codex_plans': { type: 'boolean', default: false, env: 'CC_BRIDGE_PLAN_REVIEW', doc: 'Claude reviews Codex plans (needs cc-bridge install after enabling)' },
  'plan_review.timeout_seconds': { type: 'seconds', default: 480, max: MAX_REVIEW_SECONDS, doc: 'Longest a plan review may take' },
  start_timeout_seconds: { type: 'seconds', default: 180, doc: 'How long a started agent has to connect before a new send starts another' },
  consult_timeout_seconds: { type: 'seconds', default: 600, doc: 'Longest a consult_claude call may take' },
  max_exchange_depth: { type: 'integer', default: 20, doc: 'Messages allowed in one exchange' },
}

export function configPath() {
  return process.env.CC_BRIDGE_CONFIG || path.join(os.homedir(), '.config', 'cc-bridge', 'config.json')
}

const expandHome = p => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p)

// Returns the checked value, or throws a message naming the problem.
function check(key, spec, value) {
  const bad = what => { throw new Error(`${key} must be ${what}`) }
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string' || !value) bad('a non-empty string')
      return value
    case 'label':
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(value)) bad('1-40 letters, digits, "_" or "-"')
      return value
    case 'argv':
      if (value === null) return null
      if (!Array.isArray(value) || !value.length || !value.every(a => typeof a === 'string' && a)) bad('null or a non-empty array of strings')
      return value
    case 'path':
      if (value === null) return null
      if (typeof value !== 'string' || !path.isAbsolute(expandHome(value))) bad('null or an absolute path')
      return expandHome(value)
    case 'boolean':
      if (typeof value !== 'boolean') bad('true or false')
      return value
    case 'seconds':
    case 'integer':
      if (!Number.isInteger(value) || value < 1 || (spec.max && value > spec.max)) bad(`a whole number from 1${spec.max ? ` to ${spec.max}` : ''}`)
      return value
  }
}

function fromEnv(key, spec, raw) {
  if (spec.type === 'argv') return raw.split(' ').filter(Boolean)
  if (spec.type === 'boolean') {
    if (raw === '0' || raw === '1') return raw === '1'
    throw new Error(`${spec.env} must be 0 or 1`)
  }
  if (spec.type === 'seconds' || spec.type === 'integer') return Number(raw)
  return raw
}

function readFile(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw new Error(`cannot read ${file}: ${err.message}`)
  }
  try {
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a JSON object')
    return data
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message})`)
  }
}

let cache = null // { file, mtimeMs, size, data }
function fileData(file) {
  let st = null
  try {
    st = fs.statSync(file)
  } catch {}
  if (cache && cache.file === file && cache.mtimeMs === st?.mtimeMs && cache.size === st?.size) return cache.data
  const data = st ? readFile(file) : null
  cache = { file, mtimeMs: st?.mtimeMs, size: st?.size, data }
  return data
}

const lookup = (obj, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' && k in o ? o[k] : undefined), obj)

// Every key with its value and where it came from, plus warnings for unknown keys.
// Throws on an unreadable file or an invalid value.
export function loadConfig(env = process.env) {
  const file = configPath()
  const data = fileData(file)
  const values = {}
  const sources = {}
  for (const [key, spec] of Object.entries(SCHEMA)) {
    let value = spec.default
    let source = 'default'
    const inFile = lookup(data, key)
    if (inFile !== undefined) {
      value = inFile
      source = 'file'
    }
    if (spec.env && env[spec.env]) {
      try {
        value = fromEnv(key, spec, env[spec.env])
      } catch (err) {
        throw new Error(`cc-bridge: ${err.message}`)
      }
      source = `env ${spec.env}`
    }
    try {
      values[key] = check(key, spec, value)
    } catch (err) {
      throw new Error(`cc-bridge config: ${err.message} (from ${source === 'file' ? file : source})`)
    }
    sources[key] = source
  }
  const warnings = []
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj || {})) {
      const key = prefix + k
      if (key in SCHEMA) continue
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(SCHEMA).some(s => s.startsWith(`${key}.`))) walk(v, `${key}.`)
      else warnings.push(`unknown key "${key}" in ${file}`)
    }
  }
  walk(data, '')
  return { file, exists: data !== null, values, sources, warnings }
}

// Sets a flat dotted key in a nested object.
function put(obj, key, value) {
  const parts = key.split('.')
  let o = obj
  for (const p of parts.slice(0, -1)) o = o[p] && typeof o[p] === 'object' ? o[p] : (o[p] = {})
  o[parts.at(-1)] = value
  return obj
}

// The effective settings as a nested object (plan_review.* under plan_review).
export function config() {
  return Object.entries(loadConfig().values).reduce((out, [key, value]) => put(out, key, value), {})
}

export function defaultsJson() {
  const out = Object.entries(SCHEMA).reduce((o, [key, spec]) => put(o, key, spec.default), {})
  return JSON.stringify(out, null, 2) + '\n'
}

// Serializes config writers (config init / config set) with an O_EXCL lock file
// holding the owner's pid; a lock whose owner has exited is taken over.
function withLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lock = `${file}.lock`
  const deadline = Date.now() + 3000
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' })
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    let owner = 0
    try {
      owner = Number(fs.readFileSync(lock, 'utf8'))
    } catch {}
    if (owner > 0) {
      try {
        process.kill(owner, 0)
      } catch (err) {
        if (err.code === 'ESRCH') {
          fs.rmSync(lock, { force: true })
          continue
        }
      }
    }
    if (Date.now() > deadline) throw new Error(`${lock} is held by process ${owner || 'unknown'}; try again`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
  try {
    return fn()
  } finally {
    fs.rmSync(lock, { force: true })
  }
}

// Replaces `file` atomically (readers see the old or the new contents, never half).
function replaceFile(file, contents) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, contents)
  fs.renameSync(tmp, file)
}

// Writes the defaults if there is no config file yet; never replaces one, even one
// created at the same moment by another process. Returns false if one exists.
export function initConfig() {
  const file = configPath()
  return withLock(file, () => {
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, defaultsJson())
    try {
      fs.linkSync(tmp, file) // fails if the file exists, unlike rename
      return true
    } catch (err) {
      if (err.code === 'EEXIST') return false
      throw err
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })
}

// Sets one key (value given as JSON, or a bare string) and validates the result
// before writing. Other keys and unknown keys in the file are kept.
export function setConfig(key, raw) {
  const spec = SCHEMA[key]
  if (!spec) throw new Error(`unknown key "${key}"; known keys: ${Object.keys(SCHEMA).join(', ')}`)
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    value = raw
  }
  check(key, spec, value)
  const file = configPath()
  withLock(file, () => {
    const data = put(readFile(file) || JSON.parse(defaultsJson()), key, value) // fresh read, not the cache
    replaceFile(file, JSON.stringify(data, null, 2) + '\n')
  })
  return value
}

// Used by bin/claude-live (a shell script): `node lib/config.js get claude_bin`.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, key] = process.argv.slice(2)
  try {
    if (cmd !== 'get' || !(key in SCHEMA)) throw new Error('usage: config.js get <key>')
    const value = loadConfig().values[key]
    console.log(typeof value === 'string' ? value : JSON.stringify(value))
  } catch (err) {
    console.error(err.message)
    process.exitCode = 1
  }
}
