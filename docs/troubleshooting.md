# Troubleshooting

```sh
cc-bridge doctor              # config, capabilities, logins, registration, PATH and socket checks
cc-bridge sessions            # available conversations and their project directories
cc-bridge status              # startups, waiting requests, connection state and recovery hints
cc-bridge status --verbose    # the same, with full session identifiers
cc-bridge log -n 20           # messages, delivery status and plan reviews
```

`doctor` makes no model calls, and a passing socket check doesn't prove the channel was approved. Only a real question and reply does.

## What the delivery states mean

- `queued to Codex`: Codex's queue accepted the message. That doesn't mean the agent has read it.
- `notification sent; receipt unconfirmed`: the message was pushed to Claude. Claude channel notifications have no receipt, so this stays unconfirmed until a reply arrives. Approve the channel prompt before relying on notifications; one sent before approval may not reach the agent.
- `replied`: a real reply arrived.
- `waiting for connection`: the other agent is still starting. More messages join the same startup, keep their original IDs and timestamps, and wait even if approval takes longer than `start_timeout_seconds`.
- `unconfirmed`: a handover was interrupted. It is not resent automatically.
- `dropped`: the conversation or pairing changed before handover. The request is kept in the log with the reason, and never sent to another conversation.

## Recovering a request

Every waiting request appears in `status` and `log` with its request ID. If an agent exits or its startup fails, the recovery hint names one of:

```sh
cc-bridge retry <message-id>    # restart the original destination and hand the request over
cc-bridge cancel <message-id>   # withdraw a request that hasn't been handed over yet
```

- Closing a window never reopens it automatically; the waiting requests stay available for `retry`.
- Retry refuses to open a second window while the first agent is still running.
- Retrying a message that was already queued to Codex only reopens its original conversation; it doesn't queue the message again.
- An explicit retry of an `unconfirmed` Codex handover may duplicate the request, because Codex's queue has no deduplication.
- A Claude notification already recorded as sent is never resent. If no reply comes, ask the agent to send a new request.
- Cancel can't recall a notification or a queued message.

After updating the bridge, restart both agents so they use the same pending-request format. Older pending records are upgraded when processed.

## Reconnecting

- Resuming the **same conversation** keeps its pairing.
- `/clear`, a new conversation, or switching conversations changes the channel identity and invalidates the old pairing. Tell Codex **"Connect to Claude session <label>"** to reconnect (`cc-bridge sessions` lists labels).
- The plugin's `SessionStart`/`SessionEnd` hooks track the conversation for each `claude-live` process and do nothing in other sessions. If hooks are disabled, the channel uses the conversation ID Claude was started with and won't follow `/clear`.
- Matching uses the Git working-tree root (or the working directory outside Git), so subdirectories and symlinks count as the same project, and separate worktrees stay separate.

Manual pairing while the Claude channel is running:

```sh
cc-bridge pair --claude review --codex <thread-uuid>
cc-bridge unpair --claude review
```

## Agent tools

- **Codex:** `list_sessions`, `connect_claude(project_dir, session?)`, `send_to_claude`, `reply`, `bridge_status`, `pair_with_claude`, `consult_claude`, `list_consultations`
- **Claude:** `send_to_codex`, `reply`, `bridge_status`

Each message accepts one reply. To follow up, reply to the reply you received, or start a new message. An exchange is capped at `max_exchange_depth` messages.

An explicit session selection can replace a pairing, so the agents are instructed to ask before choosing among candidates or changing a connection.

`consult_claude` asks a separate, read-only Claude (Read/Grep/Glob only) instead of the live session. It uses your Claude quota.
