import fs from 'node:fs'
import path from 'node:path'
import { dataDir, newId, validLabel } from './common.js'
import { config } from './config.js'
import { withStoreLock, readStore, writeStore, processAlive, processIdentity } from './store.js'

export const launchFile = id => {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid launch ID')
  return path.join(dataDir(), 'launches', `${id}.json`)
}
export const readLaunch = id => readStore(launchFile(id))
export function listLaunches() {
  const dir = path.join(dataDir(), 'launches')
  try { return fs.readdirSync(dir).filter(f => /^[0-9a-f-]{36}\.json$/.test(f)).map(f => readLaunch(f.slice(0, -5))).filter(Boolean).sort((a, b) => a.created_at.localeCompare(b.created_at)) }
  catch (e) { if (e.code === 'ENOENT') return []; throw e }
}
export function launchState(l) {
  if (l.state === 'running' && l.owner && !processAlive(l.owner) && !processAlive(l.agent)) return 'exited'
  return l.state
}
export async function updateLaunch(id, patch) {
  return withStoreLock('launches', () => {
    const l = readLaunch(id)
    if (!l || l.state === 'superseded') return null
    const change = typeof patch === 'function' ? patch(l) : patch
    if (!change) return l
    Object.assign(l, change)
    writeStore(launchFile(id), l)
    return l
  })
}
// Reservation is written BEFORE opening a terminal. Slow launchers never cause a
// second window on another send. Only explicit recovery supersedes an attempt.
export async function reserveLaunch(spec, retry = false) {
  return withStoreLock('launches', () => {
    const all = listLaunches()
    const previous = all.filter(l => l.kind === spec.kind && l.label === spec.label && l.state !== 'superseded').at(-1)
    const same = previous && previous.claude_session === spec.claude_session && previous.codex === spec.codex && previous.generation === spec.generation
    if (same && !retry) {
      const state = launchState(previous)
      if (!previous.connected || !['exited', 'failed'].includes(state)) return { launch: { ...previous, state }, fresh: false }
    }
    if (previous) {
      if (retry && (processAlive(previous.owner) || processAlive(previous.agent))) throw new Error('The agent window is still open. Finish its prompts or close it before retrying.')
      if (retry && previous.state === 'starting' && !previous.owner && Date.now() - new Date(previous.created_at).getTime() < config().start_timeout_seconds * 1000) throw new Error('The terminal is still opening; no second window opened. Check cc-bridge status.')
      previous.state = 'superseded'
      writeStore(launchFile(previous.id), previous)
    }
    const launch = { ...spec, id: newId(), created_at: new Date().toISOString(), state: 'starting' }
    writeStore(launchFile(launch.id), launch)
    return { launch, fresh: true }
  })
}

// Host ancestry identifies bootstrap callers even if the model omits launch_id.
// Old wrappers remain in the registry to reject late, superseded connections.
export function callerLaunch(kind, pid = process.pid) {
  const launches = listLaunches().filter(l => l.kind === kind)
  for (let n = 0; pid > 1 && n < 100; n++) {
    const p = processIdentity(pid)
    if (!p) return null
    const launch = launches.find(l => [l.agent, l.owner].some(owner => owner?.pid === p.pid && owner.start === p.start))
    if (launch) return launch
    pid = p.parent
  }
  return null
}

export async function acceptLaunch(kind, label, identity, providedId) {
  if (!validLabel(label)) throw new Error('Invalid session label')
  return withStoreLock('launches', () => {
    const all = listLaunches()
    const provenance = callerLaunch(kind)
    if (provenance?.connected) return provenance // bootstrap is complete; normal session changes and explicit connections are independent
    if (provenance && (provenance.state === 'superseded' || provenance.label !== label)) throw new Error('This startup was superseded; not replacing the current connection.')
    if (providedId && provenance?.id !== providedId) throw new Error('Launch ID does not match this agent process.')
    const candidates = all.filter(l => l.kind === kind && l.label === label && l.state !== 'superseded')
    if (!provenance && all.some(l => l.kind === kind && l.label === label && l.state === 'superseded' && !l.connected)) throw new Error('Startup provenance is ambiguous after a retry; connection was not changed.')
    if (candidates.length > 1) throw new Error('Ambiguous startup; connection was not changed.')
    let l = provenance || candidates[0]
    if (!l) {
      const pending = readStore(path.join(dataDir(), `pending-${kind}`, `${label}.json`))
      if (!pending) return null // manual connection
      l = { id: newId(), kind, label, claude_session: pending.claude_session, codex: pending.codex || null, cwd: pending.cwd, created_at: new Date().toISOString(), state: 'exited' }
    }
    if (!provenance && (processAlive(l.owner) || processAlive(l.agent))) throw new Error('Another agent process owns this startup; connection was not changed.')
    if (l.connected && l.connected !== identity) throw new Error('Startup already connected to another conversation; not replacing it.')
    l.connected = identity
    writeStore(launchFile(l.id), l)
    return l
  })
}
