// Outbound delivery in each direction. Never retries and never reroutes:
// a failure is recorded and reported to the calling agent as-is.
import { execFile } from 'node:child_process'
import {
  claudeParty,
  codexParty,
  formatForCodex,
  newId,
  record,
  sendToClaudeSocket,
} from './common.js'
import { config } from './config.js'

const codexBin = () => config().codex_bin

// Claude → Codex via `codex queue`. "queued" means Codex accepted it; the
// session picks it up at its next turn boundary (or when resumed).
// Every record names the exact Claude conversation, so a reply can never be routed
// to a different conversation that later took over the label.
export function deliverToCodex({ fromLabel, claudeSession, thread, text, replyToId, kind = 'message' }) {
  const msgId = newId()
  const base = { msg_id: msgId, from: claudeParty(fromLabel), to: codexParty(thread), claude_session: claudeSession, reply_to: replyToId || null, kind }
  record({ event: 'sent', ...base, text })
  const message = formatForCodex({ msgId, fromLabel, replyToId, kind, text })
  return new Promise(resolve => {
    const child = execFile(
      codexBin(),
      ['queue', '--thread', thread, '--message', message],
      { timeout: 20000 },
      (err, stdout, stderr) => {
        if (err) {
          const error = (stderr || err.message).trim().split('\n').slice(-3).join(' | ')
          record({ event: 'failed', msg_id: msgId, error })
          resolve({ status: 'failed', msg_id: msgId, error })
          return
        }
        record({ event: 'queued', msg_id: msgId, detail: stdout.trim() })
        resolve({ status: 'queued', msg_id: msgId })
      },
    )
    child.stdin?.end()
  })
}

// Codex → Claude via the live session's channel socket. The channel rejects the
// message unless it is still the Claude conversation `claudeSession` from the pairing.
export async function deliverToClaude({ fromThread, label, claudeSession, text, replyToId, kind = 'message' }) {
  const msgId = newId()
  const base = { msg_id: msgId, from: codexParty(fromThread), to: claudeParty(label), claude_session: claudeSession, reply_to: replyToId || null, kind }
  record({ event: 'sent', ...base, text })
  const res = await sendToClaudeSocket(label, { op: 'deliver', ...base, text })
  if (res.status === 'delivered') return { status: 'delivered', msg_id: msgId }
  record({ event: 'failed', msg_id: msgId, error: res.error || res.status })
  return { status: res.status === 'ok' ? 'error' : res.status, msg_id: msgId, error: res.error }
}
