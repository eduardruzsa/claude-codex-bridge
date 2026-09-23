import fs from 'node:fs'
import path from 'node:path'
import { dataDir, newId, record, readTranscript, validLabel, claudeParty, codexParty } from './common.js'
import { withStoreLock, readStore, writeStore, processIdentity, processAlive } from './store.js'

export function pendingFile(kind, label) {
  if (!['claude', 'codex'].includes(kind) || !validLabel(label)) throw new Error('Invalid pending destination')
  return path.join(dataDir(), `pending-${kind}`, `${label}.json`)
}
export const readPending = (kind, label) => readStore(pendingFile(kind, label))
const lock = (kind, label, fn) => withStoreLock(`pending:${kind}:${label}`, fn)
function describe(kind, label, p, m) {
  return { msg_id: m.msg_id, created_at: m.created_at, text: m.text, label, destination: kind,
    from: kind === 'claude' ? codexParty(p.codex) : claudeParty(label),
    to: kind === 'claude' ? claudeParty(label) : (p.codex ? codexParty(p.codex) : 'codex:starting'),
    claude_session: p.claude_session, kind: 'message', cwd: p.cwd }
}
function normalize(kind, label, p) {
  if (!p) return p
  const events = readTranscript()
  for (const m of p.messages) {
    m.msg_id ||= newId()
    m.created_at ||= new Date(m.ts || p.started_at || Date.now()).toISOString()
    m.state ||= 'pending'
    if (m.state === 'claimed' && (!processAlive(m.owner) || Date.now() - (m.claimed_at || 0) > 30000)) {
      const evidence = events.findLast(e => e.msg_id === m.msg_id && ['queued', 'delivered', 'notification_sent', 'dropped'].includes(e.event))
      m.state = evidence?.event || (m.phase === 'preparing' ? 'pending' : 'unconfirmed')
      delete m.claim_id
      delete m.owner
      record({ event: m.state, ...describe(kind, label, p, m), reason: 'Interrupted handover; not automatically resent' })
    }
    if (!events.some(e => e.msg_id === m.msg_id && e.event === 'pending')) record({ event: 'pending', ...describe(kind, label, p, m) })
  }
  return p
}
export async function addPending(kind, label, key, text, now = Date.now()) {
  return lock(kind, label, () => {
    const current = normalize(kind, label, readPending(kind, label))
    const same = current && Object.entries(key).every(([k, v]) => current[k] === v)
    if (current && !same) {
      if (current.messages.some(m => m.state === 'claimed')) throw new Error('Previous handover is in progress; request not accepted. Try again shortly.')
      for (const m of current.messages.filter(m => m.state === 'pending')) record({ event: 'dropped', ...describe(kind, label, current, m), reason: 'Conversation or destination changed' })
    }
    const m = { msg_id: newId(), created_at: new Date(now).toISOString(), text, state: 'pending' }
    const active = same && current.messages.some(m => ['pending', 'claimed'].includes(m.state))
    const next = active ? current : { ...key, batch_id: newId(), started_at: now, messages: [] }
    next.messages.push(m)
    writeStore(pendingFile(kind, label), next)
    record({ event: 'pending', ...describe(kind, label, next, m) })
    return { msg_id: m.msg_id, batch_id: next.batch_id, launch: !active, stale: !!current && !same }
  })
}
export async function claimPending(kind, label, id) {
  return lock(kind, label, () => {
    const p = normalize(kind, label, readPending(kind, label))
    if (!p) return null
    // Only one consumer per destination, preserving order across processes.
    if (p.messages.some(m => m.state === 'claimed')) { writeStore(pendingFile(kind, label), p); return null }
    const m = p.messages.find(m => m.state === 'pending' && (!id || m.msg_id === id))
    if (m) { m.state = 'claimed'; m.owner = processIdentity(); m.claim_id = newId(); m.claimed_at = Date.now(); m.phase = 'preparing' }
    writeStore(pendingFile(kind, label), p)
    if (m) record({ event: 'claimed', ...describe(kind, label, p, m) })
    return m ? { ...p, message: { ...m } } : null
  })
}
export async function finishPending(kind, label, id, state, reason, claimId) {
  return lock(kind, label, () => {
    const p = readPending(kind, label)
    const m = p?.messages.find(m => m.msg_id === id)
    if (!m) throw new Error(`Pending request ${id} disappeared`)
    if (claimId && m.claim_id !== claimId) throw new Error('Handover claim expired; not modifying another attempt')
    m.state = state
    delete m.owner
    delete m.claim_id
    writeStore(pendingFile(kind, label), p)
    record({ event: state, ...describe(kind, label, p, m), ...(reason && { reason }) })
  })
}
export function listPending() {
  const result = []
  for (const kind of ['claude', 'codex']) {
    const dir = path.join(dataDir(), `pending-${kind}`)
    let files
    try { files = fs.readdirSync(dir) } catch (e) { if (e.code === 'ENOENT') continue; throw e }
    for (const f of files.filter(f => f.endsWith('.json'))) {
      const label = f.slice(0, -5)
      if (!validLabel(label)) continue
      const p = readPending(kind, label)
      if (p) result.push({ ...p, destination: kind, label })
    }
  }
  return result
}
export async function cancelPending(id) {
  const p = listPending().find(p => p.messages.some(m => m.msg_id === id))
  if (!p) throw new Error(`Unknown pending request ${id}`)
  return lock(p.destination, p.label, () => {
    const current = readPending(p.destination, p.label)
    const m = current?.messages.find(m => m.msg_id === id)
    if (!m) throw new Error(`Request ${id} is no longer pending`)
    if (m.state !== 'pending') throw new Error('Handover already claimed or completed; cancellation cannot recall it.')
    m.state = 'cancelled'
    writeStore(pendingFile(p.destination, p.label), current)
    record({ event: 'cancelled', ...describe(p.destination, p.label, current, m) })
  })
}

export async function bindPending(kind, label, id, identity, claimId) {
  return lock(kind, label, () => {
    const p = readPending(kind, label)
    if (!p?.messages.some(m => m.msg_id === id && m.state === 'claimed' && (!claimId || m.claim_id === claimId))) throw new Error('Handover is no longer claimed')
    const key = kind === 'claude' ? 'claude_session' : 'codex'
    if (p[key] && p[key] !== identity) throw new Error('Pending destination changed; not rerouting')
    p[key] = identity
    writeStore(pendingFile(kind, label), p)
  })
}

export async function inspectPending(kind, label) {
  return lock(kind, label, () => {
    const p = normalize(kind, label, readPending(kind, label))
    if (p) writeStore(pendingFile(kind, label), p)
    return p
  })
}

export async function beginHandover(kind, label, id, claimId) {
  return lock(kind, label, () => {
    const p = readPending(kind, label)
    const m = p?.messages.find(m => m.msg_id === id)
    if (!m || m.state !== 'claimed' || m.claim_id !== claimId) throw new Error('Handover claim expired; request not sent')
    m.phase = 'sending'
    m.claimed_at = Date.now()
    writeStore(pendingFile(kind, label), p)
  })
}
export async function releaseClaim(kind, label, id, claimId, reason) {
  return lock(kind, label, () => {
    const p = readPending(kind, label)
    const m = p?.messages.find(m => m.msg_id === id)
    if (!m || m.claim_id !== claimId || m.state !== 'claimed') return
    m.state = m.phase === 'sending' ? 'unconfirmed' : 'pending'
    delete m.owner
    delete m.claim_id
    writeStore(pendingFile(kind, label), p)
    record({ event: m.state, ...describe(kind, label, p, m), reason })
  })
}
