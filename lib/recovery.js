import { listPending, inspectPending, claimPending, bindPending, beginHandover, finishPending, releaseClaim } from './pending.js'
import { withStoreLock } from './store.js'
import { messages } from './messages.js'
import { loadPairs, sendToClaudeSocket, parseParty } from './common.js'
import { launchClaude, launchCodex, bootstrapPrompt, RESUME_PROMPT, codexThreadRunning } from './launch.js'
import { deliverToClaude, deliverToCodex } from './deliver.js'

export async function retryMessage(id) {
  // One CLI recovery per request. No pending/pair lock is held during transport.
  return withStoreLock(`retry:${id}`, async () => {
    const initial = listPending().find(p => p.messages.some(m => m.msg_id === id))
    const inspected = initial && await inspectPending(initial.destination, initial.label)
    const held = inspected?.messages.some(m => m.msg_id === id) ? { ...initial, ...inspected } : null
    const current = held
    const entry = messages().find(m => m.msg_id === id)
    if (!entry) throw new Error(`Unknown request ${id}`)
    const m = current ? { ...entry, claude_session: current.claude_session,
      ...(held.destination === 'codex' && current.codex ? { to: `codex:${current.codex}` } : {}) } : entry
    const pair = loadPairs()[held?.label || m.label || (parseParty(m.to).side === 'claude' ? parseParty(m.to).id : parseParty(m.from).id)]
    const label = held?.label || (parseParty(m.to).side === 'claude' ? parseParty(m.to).id : parseParty(m.from).id)
    const state = current?.messages.find(m => m.msg_id === id)?.state
    if (state === 'claimed') throw new Error('Handover is in progress; no duplicate sent.')
    if (['cancelled', 'dropped', 'replied'].includes(m.state)) throw new Error(`Request is ${m.state}; it cannot be retried.`)
    if (state === 'pending') {
      if (held.claude_session && pair && (pair.claude_session !== held.claude_session || (held.codex && pair.codex !== held.codex))) throw new Error('Pairing changed; request preserved, not rerouted.')
      if (held.destination === 'claude') {
        const ping = await sendToClaudeSocket(label, { op: 'ping' })
        if (ping.status === 'ok' && (!held.claude_session || held.claude_session === ping.session)) return 'Claude is running; the pending request will be handed over by its channel.'
        if (ping.status !== 'disconnected') throw new Error('Claude is still running or switching; no second window opened.')
        await launchClaude(held.cwd || pair?.cwd, label, held.claude_session ? ['--resume', held.claude_session] : [], held.codex, true, held.claude_session ? undefined : held.batch_id)
      } else {
        const ping = await sendToClaudeSocket(label, { op: 'ping' })
        if (ping.status !== 'ok' || ping.session !== held.claude_session) throw new Error('Original Claude conversation must be running before retrying its startup.')
        if (pair && pair.claude_session === held.claude_session && (!held.codex || pair.codex === held.codex) && codexThreadRunning(pair.codex)) {
          const pending = await claimPending('codex', label, id)
          if (!pending) throw new Error('Request was cancelled, claimed, or already handed over; no duplicate sent.')
          const message = pending.message
          try {
            await bindPending('codex', label, id, pair.codex, message.claim_id)
            await beginHandover('codex', label, id, message.claim_id)
            const result = await deliverToCodex({ fromLabel: label, claudeSession: held.claude_session, thread: pair.codex, text: message.text, msg_id: id, created_at: message.created_at })
            await finishPending('codex', label, id, result.status, result.error, message.claim_id)
            return `${result.status}: request ${id} handed to the existing Codex conversation; no new window opened.`
          } catch (err) {
            await releaseClaim('codex', label, id, message.claim_id, err.message)
            throw err
          }
        }
        await launchCodex(held.cwd, held.codex ? ['resume', held.codex, RESUME_PROMPT] : [bootstrapPrompt(label, held.cwd)], label, held.claude_session, held.codex || null, true, held.codex ? undefined : held.batch_id)
      }
      return `Startup retried; request ${id} and other waiting requests are preserved.`
    }
    if (!pair || pair.claude_session !== m.claude_session) throw new Error('Original pairing is unavailable; not rerouting.')
    const toClaude = parseParty(m.to).side === 'claude'
    if (pair.codex !== parseParty(toClaude ? m.from : m.to).id) throw new Error('Original Codex pairing changed; not rerouting.')
    if (['notification_sent', 'delivered'].includes(m.state)) {
      return 'Claude notification was already submitted; receipt is unconfirmed. Deduplication prevents resending this request. Ask the agent to send a new request if needed.'
    }
    if (m.state === 'queued') {
      if (codexThreadRunning(pair.codex)) return 'Already queued to the running Codex conversation; no duplicate sent.'
      await launchCodex(pair.cwd, ['resume', pair.codex, RESUME_PROMPT], label, pair.claude_session, pair.codex, true)
      return 'Reopened the original Codex conversation; the queued message was not sent again.'
    }
    if (!['failed', 'unconfirmed'].includes(m.state)) throw new Error(`Request is ${m.state}; no retry is needed.`)
    const args = { msg_id: id, created_at: m.created_at, text: m.text, replyToId: m.reply_to, kind: m.kind, claudeSession: pair.claude_session }
    const result = toClaude
      ? await deliverToClaude({ ...args, fromThread: pair.codex, label })
      : await deliverToCodex({ ...args, fromLabel: label, thread: pair.codex })
    return `${result.status}: explicit retry ${id}. ${toClaude ? 'Notification receipt remains unconfirmed.' : 'An unconfirmed earlier queue attempt may also have succeeded.'}${result.error ? ` ${result.error}` : ''}`
  })
}
