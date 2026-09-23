import fs from 'node:fs'
import { listPending, inspectPending } from './pending.js'
import { listLaunches, launchState } from './launch-state.js'
import { messages, age, stateLabel } from './messages.js'
import { startTimeoutMs, runningCodexThreads } from './launch.js'
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
  const pending = await Promise.all(listPending().map(async p => ({ ...p, ...await inspectPending(p.destination, p.label) })))
  const launches = listLaunches().filter(l => l.state !== 'superseded')
  const recent = messages()
  const running = runningCodexThreads()
  let files = []
  try { files = fs.readdirSync(runtimeDir()) } catch (e) { if (e.code !== 'ENOENT') throw e }
  const labels = new Set([...Object.keys(pairs), ...pending.map(p => p.label), ...launches.map(l => l.label)])
  for (const f of files) {
    const match = /^claude-(.+)\.sock$/.exec(f)
    if (match && validLabel(match[1])) labels.add(match[1])
  }
  return Promise.all([...labels].sort().map(async label => {
    const ping = await sendToClaudeSocket(label, { op: 'ping' }, 1000)
    const pair = pairs[label]
    const live = ping.status === 'ok'
    let state = !live ? (ping.status === 'transitioning' ? 'transitioning' : 'disconnected')
      : !pair ? 'available' : pair.claude_session === ping.session ? 'paired' : 'conversation-changed'
    const launch = launches.findLast(l => l.label === label)
    const latest = recent.filter(m => m.label === label || m.from === `claude:${label}` || m.to === `claude:${label}`).at(-1)
    const waiting = pending.filter(p => p.label === label).flatMap(p => p.messages.filter(m => !m.state || m.state === 'pending'))
    if (state !== 'conversation-changed' && waiting.length && launch && !launch.connected) {
      const ls = launchState(launch)
      state = ['failed', 'exited'].includes(ls) ? 'needs recovery'
        : Date.now() - new Date(launch.created_at).getTime() > startTimeoutMs() ? 'waiting for connection' : 'starting'
    }
    if (launch && ['failed', 'exited'].includes(launchState(launch)) && (waiting.length || (launch.kind === 'codex' && !running.has(pair?.codex) && latest?.state === 'queued' && latest.to === `codex:${pair?.codex}`)) && state !== 'conversation-changed') state = 'needs recovery'
    if (state !== 'conversation-changed' && launch?.state === 'starting' && !launch.owner && !launch.connected && Date.now() - new Date(launch.created_at).getTime() > startTimeoutMs()) state = 'startup unconfirmed'
    let project = pair?.cwd || launch?.cwd || pending.find(p => p.label === label)?.cwd || null
    if (live && ping.cwd) { try { project = projectDir(ping.cwd) } catch {} }
    return { label, state, project, waiting, launch, latest, codex_running: !!pair && running.has(pair.codex), session: ping.session || null, codex: pair?.codex || null,
      lifecycle: ping.lifecycle === true, recovery: state === 'startup unconfirmed' ? `The terminal has not reported starting the agent. Check the terminal setting; retry with cc-bridge retry ${waiting[0]?.msg_id || latest?.msg_id || '<message-id>'}`
        : state === 'needs recovery' && (waiting[0]?.msg_id || latest?.msg_id) ? `cc-bridge retry ${waiting[0]?.msg_id || latest.msg_id}`
        : ['starting', 'waiting for connection'].includes(state) ? 'Finish the prompts in the agent window; your requests are preserved.'
        : state === 'disconnected' ? `${project ? `cd ${quote(project)} && ` : ''}CC_BRIDGE_LABEL=${label} claude-live --resume ${quote(pair?.claude_session || '<session-id>')}`
        : state === 'conversation-changed' ? `Select Claude session "${label}" explicitly to reconnect.` : null }
  }))
}

export async function connectClaude(thread, dir, selected, expectedSession) {
  if (selected) return { label: selected, ...await pairLive(selected, thread, { expectedSession }) }
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

const quote = s => "'" + String(s).replaceAll("'", "'\\''") + "'"

export function formatSessions(sessions, { verbose = false } = {}) {
  if (!sessions.length) return 'No Claude sessions found. Start claude-live in your project.'
  return sessions.map(s => [
    `${s.label}: ${s.state} | ${s.project || 'project unavailable'}`,
    `  Claude ${s.session ? 'running' : 'not connected'} | Codex ${s.codex ? (s.codex_running ? 'running' : 'not running') : 'unpaired'}`,
    ...(s.launch && !s.launch.connected ? [`  ${s.launch.kind === 'codex' ? 'Codex' : 'Claude'} startup: ${launchState(s.launch)}`] : []),
    ...(s.waiting?.length ? [`  ${s.waiting.length} waiting request(s); oldest ${age(s.waiting[0].created_at || s.waiting[0].ts)} ago`] : []),
    ...(s.latest ? [`  Latest: ${stateLabel(s.latest.state)} — ${String(s.latest.text).replaceAll('\n', ' ').slice(0, 90)}`] : []),
    ...(verbose ? [`  Claude ${s.session || 'unavailable'} | Codex ${s.codex || 'unpaired'}`] : []),
    ...(!s.lifecycle && s.session ? ['  Restart with the updated claude-live to enable conversation-switch tracking.'] : []),
    ...(s.recovery ? [`  Next: ${s.recovery}`] : []),
  ].join('\n')).join('\n')
}
