import fs from 'node:fs'
import path from 'node:path'

// Hooks carry authoritative session IDs. One private directory belongs to one
// launcher, not to a reusable label. The hook writer serializes updates with flock.
export function transition(state, event, order) {
  if (!['SessionStart', 'SessionEnd'].includes(event.hook_event_name) || !event.session_id) {
    throw new Error('invalid lifecycle event')
  }
  state ||= { order: '0', ended: {} }
  if (BigInt(order) <= BigInt(state.order)) return state
  const ended = { ...state.ended }
  const session = event.session_id
  if (event.hook_event_name === 'SessionEnd') {
    ended[session] = order
    return { ...state, order, ended, ...(state.session === session || !state.session ? { ready: false } : {}) }
  }
  // An old background startup must not revive a conversation after /clear.
  if (ended[session] && event.source !== 'resume') return state
  return { order, ended, session, cwd: event.cwd, ready: true, source: event.source }
}

export function identity() {
  const dir = process.env.CC_BRIDGE_LIFECYCLE_DIR
  if (!dir) return { session: process.env.CLAUDE_CODE_SESSION_ID || null, cwd: process.cwd(), ready: !!process.env.CLAUDE_CODE_SESSION_ID, lifecycle: false }
  try {
    return { ...JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')), lifecycle: true }
  } catch {
    return { session: null, ready: false, lifecycle: true }
  }
}

export function updateState(dir, event, order) {
  const file = path.join(dir, 'state.json')
  let state
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
  const next = transition(state, event, order)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 })
  fs.renameSync(tmp, file)
}
