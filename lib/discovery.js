import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { runtimeDir, loadPairs, labelForThread, pairLive, pairState, sendToClaudeSocket, validLabel } from './common.js'

export function projectDir(dir) {
  const real = fs.realpathSync(dir)
  if (!fs.statSync(real).isDirectory()) throw new Error(`not a directory: ${dir}`)
  try {
    return fs.realpathSync(execFileSync('git', ['-C', real, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim())
  } catch { return real }
}

export async function listSessions() {
  const pairs = loadPairs()
  let files = []
  try { files = fs.readdirSync(runtimeDir()) } catch (e) { if (e.code !== 'ENOENT') throw e }
  const labels = new Set(Object.keys(pairs))
  for (const f of files) {
    const match = /^claude-(.+)\.sock$/.exec(f)
    if (match && validLabel(match[1])) labels.add(match[1])
  }
  return Promise.all([...labels].sort().map(async label => {
    const ping = await sendToClaudeSocket(label, { op: 'ping' }, 1000)
    const pair = pairs[label]
    const live = ping.status === 'ok'
    const state = !live ? (ping.status === 'transitioning' ? 'transitioning' : 'disconnected')
      : !pair ? 'available' : pair.claude_session === ping.session ? 'paired' : 'conversation-changed'
    let project = null
    if (live && ping.cwd) { try { project = projectDir(ping.cwd) } catch {} }
    return { label, state, project, session: ping.session || null, codex: pair?.codex || null,
      lifecycle: ping.lifecycle === true, recovery: state === 'disconnected' ? `CC_BRIDGE_LABEL=${label} claude-live --resume ${pair?.claude_session || '<session-id>'}`
        : state === 'conversation-changed' ? `Select Claude session "${label}" explicitly to reconnect.` : null }
  }))
}

export async function connectClaude(thread, dir, selected) {
  if (selected) return { label: selected, ...await pairLive(selected, thread) }
  const current = labelForThread(thread)
  if (current) {
    const pair = loadPairs()[current]
    const state = await pairState(current, pair)
    if (state !== 'connected') throw new Error(`Existing pairing "${current}": ${state}. Select a session explicitly; not switching automatically.`)
    return { label: current, pair, replaced: [] }
  }
  const project = projectDir(dir)
  const candidates = (await listSessions()).filter(s => s.project === project && s.state === 'available')
  if (candidates.length !== 1) throw new Error(candidates.length
    ? `Several Claude conversations match: ${candidates.map(s => s.label).join(', ')}. Ask the user to select one.`
    : `No unpaired Claude conversation in ${project}. Start claude-live there, or select a session from list_sessions.`)
  const candidate = candidates[0]
  return { label: candidate.label, ...await pairLive(candidate.label, thread, { expectedSession: candidate.session, onlyUnpaired: true }) }
}

export function formatSessions(sessions) {
  if (!sessions.length) return 'No Claude sessions found. Start claude-live in your project.'
  return sessions.map(s => [
    `${s.label}: ${s.state} | ${s.project || 'project unavailable'}`,
    `  Claude ${s.session || 'unavailable'} | Codex ${s.codex || 'unpaired'} (Codex readiness not probed)`,
    ...(!s.lifecycle && s.session ? ['  Restart with the updated claude-live to enable conversation-switch tracking.'] : []),
    ...(s.recovery ? [`  Next: ${s.recovery}`] : []),
  ].join('\n')).join('\n')
}
