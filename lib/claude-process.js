// Finds the Claude Code process that launched us (MCP server or hook) and tells
// whether it was started with the cc-bridge channel. The plugin's MCP server and
// hooks load in every Claude session; they stay dormant unless the channel is on.
import fs from 'node:fs'
import path from 'node:path'
import { runtimeDir } from './common.js'

function stat(pid) {
  // comm may contain spaces/parens, so split after the last ')'.
  const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
  return { comm: raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')')), ppid: Number(fields[1]), start: fields[19] }
}

export function findClaudeProcess(from = process.ppid) {
  let pid = from
  for (let depth = 0; pid > 1 && depth < 10; depth++) {
    let s
    try {
      s = stat(pid)
    } catch {
      return null
    }
    if (s.comm === 'claude') {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
      return { pid, start: s.start, args }
    }
    pid = s.ppid
  }
  return null
}

// True when `claude` was started with --dangerously-load-development-channels (or
// --channels) naming this bridge, e.g. plugin:cc-bridge@cc-bridge.
export function launchedWithChannel(args) {
  const names = []
  for (let i = 0; i < args.length; i++) {
    const m = /^--(?:dangerously-load-development-channels|channels)(?:=(.*))?$/.exec(args[i])
    if (!m) continue
    if (m[1] !== undefined) names.push(m[1])
    else for (let j = i + 1; j < args.length && !args[j].startsWith('-'); j++) names.push(args[j])
  }
  return names.flatMap(n => n.split(/[\s,]+/)).some(n => /^(plugin:cc-bridge@|server:cc-bridge$)/.test(n))
}

// CC_BRIDGE_ACTIVE=1 forces the channel on (tests, custom launchers).
export function channelActive(proc = findClaudeProcess()) {
  if (process.env.CC_BRIDGE_ACTIVE === '1') return true
  return !!proc && launchedWithChannel(proc.args)
}

// Private per-Claude-process directory shared by the lifecycle hook and the channel
// server. pid + start time, so a recycled pid never inherits old state.
export function lifecycleDirFor(proc) {
  return path.join(runtimeDir(), `proc-${proc.pid}-${proc.start}`)
}

// Removes lifecycle directories whose Claude process (pid + start time) has ended.
export function sweepLifecycleDirs() {
  let entries = []
  try {
    entries = fs.readdirSync(runtimeDir())
  } catch {
    return
  }
  for (const name of entries) {
    const m = /^proc-(\d+)-(\d+)$/.exec(name)
    if (!m) continue
    let alive = false
    try {
      alive = stat(Number(m[1])).start === m[2]
    } catch {}
    if (!alive) fs.rmSync(path.join(runtimeDir(), name), { recursive: true, force: true })
  }
}
