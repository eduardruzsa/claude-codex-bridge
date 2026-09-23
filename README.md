# claude-codex-bridge

A local two-way bridge between a live Claude Code session and a live Codex session. Either agent can start an exchange, reply and follow up, and nobody has to copy messages between terminals.

| Direction | Transport |
|---|---|
| Codex → Claude | `codex-mcp.js` → user-only Unix socket → `claude-channel.js` → [Claude Channel](https://code.claude.com/docs/en/channels-reference) event |
| Claude → Codex | `claude-channel.js` → `codex queue --thread <uuid>` → Codex handles it at its next turn |
| Codex → separate Claude | `consult_claude` runs `claude -p --restricted` with only Read/Grep/Glob (no user hooks, plugins or MCP), and `session_id` lets it follow up |

Bridge messages ask for discussion or review. They never authorize edits, state-changing commands or deploys.

## Setup (already done on this machine)

```
npm install
codex mcp add cc-bridge -- node ~/Work/claude-codex-bridge/codex-mcp.js
ln -s ~/Work/claude-codex-bridge/bin/claude-live ~/.local/bin/claude-live
ln -s ~/Work/claude-codex-bridge/bin/cc-bridge ~/.local/bin/cc-bridge
```

`claude-live` loads the channel through an inline `--mcp-config`, so ordinary `claude` sessions don't load the bridge at all.

## Use

1. Start Claude with the channel. Arguments pass through to `claude`, so `--resume`/`--continue` work. Claude asks once for development-channel approval.
   ```
   claude-live --continue
   ```
   To run more than one live session, give each one a name: `CC_BRIDGE_LABEL=review claude-live`. The default name is `claude`.
2. In Codex, restart the session or reload MCP so the `cc-bridge` tools appear. Then ask it to pair:
   > Pair with Claude session "claude" using cc-bridge.

   Codex calls `pair_with_claude`, and Codex itself tells the bridge which thread is calling. The pairing binds that exact Claude conversation (`CLAUDE_CODE_SESSION_ID`). A later conversation that reuses the label has to be paired again. You can also pair by hand while `claude-live` is running:
   ```
   cc-bridge pair --claude claude --codex <thread-uuid>
   ```
3. Tell either agent to ask the other something. Answers arrive on their own:
   - Codex answers show up in Claude as `<channel source="cc-bridge" …>` events.
   - Claude answers show up in Codex as queued `[cc-bridge reply from Claude …]` messages.

## Inspect

```
cc-bridge status        # pairings + whether each Claude session is connected
cc-bridge log -n 20     # transcript with delivery status
```

## Tools

| Claude (live channel) | Codex |
|---|---|
| `send_to_codex(text)` | `send_to_claude(text, session?)` |
| `reply(msg_id, text)` | `reply(msg_id, text)` |
| `bridge_status()` | `bridge_status()`, `pair_with_claude(session)` |
| | `consult_claude(prompt, session_id?, label?, cwd?)`, `list_consultations()` |

## Guarantees

- **Addressing:** pairings are one-to-one between a Claude conversation (its label plus `CLAUDE_CODE_SESSION_ID`) and a Codex thread UUID. A message goes only to its paired conversation and is never rerouted. If the label now belongs to a different conversation, the send fails with `session_changed`.
- **Replies stay with their conversation:** every message records its Claude conversation. A reply to a message from an earlier conversation is refused, even when the label and Codex thread have since been re-paired.
- **Codex identity:** the host-set `_meta.threadId` on each tool call identifies the calling Codex thread. The model can't set it. The bridge also checks that the thread's `rollout-*.jsonl` is open in the parent Codex process. Two threads sharing one Codex process can't act as each other.
- **Socket ownership:** a Linux abstract-namespace socket acts as the lock for each label. Only one process can bind it, and the kernel releases it when that process dies. That leaves no stale lock to recover and no race between two starting processes. A socket file is replaced only by the new owner, and cleanup can't remove a successor's socket.
- **Consultations:** a follow-up can resume only a `session_id` this bridge created, and always runs in that consultation's original directory.
- **Delivery status:** sends are asynchronous. Codex-bound messages report `queued`; Claude-bound messages report `delivered`, `disconnected`, `unknown session` or `timeout`. Failed sends are never retried automatically.
- **Loop limits:** each message accepts one reply, an exchange is capped at 20 messages, and duplicate `msg_id`s are dropped. Tool descriptions tell both agents not to send acknowledgement-only replies.
- **Private storage:**
  - The socket directory is `$XDG_RUNTIME_DIR/cc-bridge` (0700), and every socket request carries a token from `~/.local/share/cc-bridge/token` (0600).
  - The transcript, pairings and consultations are stored in `~/.local/share/cc-bridge/`, readable only by you.

## Quirks

- Codex removes `XDG_RUNTIME_DIR` from MCP server environments, so the bridge falls back to `/run/user/<uid>`.
- A Claude `/clear` inside the same process keeps the MCP server running with the old conversation id, so re-pair after `/clear`.
- A Codex thread handles queued messages at its next turn boundary. An idle Codex TUI picks them up immediately; a closed thread picks them up when resumed.
- Custom channels are a research-preview Claude Code feature and require `--dangerously-load-development-channels`. That flag skips only the channel allowlist. Tool permissions are unchanged.

## Test

```
npm test                                         # both servers end to end, fake codex/claude binaries
CC_BRIDGE_LIVE=1 node --test test/live.test.js   # real claude: no hooks, read-only tools, writes blocked
```
