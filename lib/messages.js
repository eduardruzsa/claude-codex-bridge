import { readTranscript } from './common.js'

export function messages(events = readTranscript()) {
  const rows = new Map()
  for (const e of events) {
    if (!e.msg_id) continue
    let row = rows.get(e.msg_id)
    if (['pending', 'sent'].includes(e.event)) {
      row = { ...row, ...e, created_at: row?.created_at || e.created_at || e.ts, state: e.event === 'sent' ? 'unconfirmed' : 'pending' }
      rows.set(e.msg_id, row)
    } else if (row && e.event !== 'duplicate') {
      row.state = e.event
      row.reason = e.reason || e.error
      row.updated_at = e.ts
    }
  }
  for (const row of rows.values()) {
    if (row.reply_to && !['failed', 'dropped', 'cancelled', 'pending'].includes(row.state)) {
      const original = rows.get(row.reply_to)
      if (original) { original.state = 'replied'; original.reason = null }
    }
  }
  return [...rows.values()]
}
export function stateLabel(state) {
  return ({ pending: 'waiting for connection', claimed: 'handover in progress', sent: 'handover unconfirmed', unconfirmed: 'handover unconfirmed',
    notification_sent: 'notification sent; receipt unconfirmed', delivered: 'notification sent; receipt unconfirmed',
    queued: 'queued to Codex', replied: 'replied' })[state] || state
}
export function age(created) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(created).getTime()) / 1000))
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`
}
export function formatMessages(rows, { verbose = false } = {}) {
  if (!rows.length) return 'No bridge requests yet.'
  const party = value => !verbose && value?.startsWith('codex:') ? 'Codex' : value
  return rows.map(m => `${m.created_at}  ${party(m.from)} → ${party(m.to)}  [${stateLabel(m.state)}]\n` +
    `  request ${m.msg_id}${verbose && m.reply_to ? `  reply to ${m.reply_to}` : ''}\n` +
    `  ${String(m.text || '').replaceAll('\n', '\n  ')}${m.reason ? `\n  ${m.reason}` : ''}`).join('\n\n')
}
