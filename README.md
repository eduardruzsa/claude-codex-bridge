# Claude ⇄ Codex bridge

Ask either agent to discuss or review something with the other, without copying messages between terminals.

## Setup

Requirements: Linux, Node **22.23.2 or newer**, Git, `flock` (util-linux), Claude Code with Channels and `--restricted`, a Claude login, and Codex with `codex queue`. Tested with Claude Code 2.1.280 and Codex 0.156.1. Linux is required for `/proc` and abstract sockets.

After cloning this repository, run from its directory:

```sh
npm run setup
```

Setup installs the locked dependencies, registers `cc-bridge` in Codex, and links `claude-live` and `cc-bridge` into `~/.local/bin`. It is safe to repeat: other MCP entries are preserved, and unrelated files or conflicting registrations are never overwritten. Keep the repository at its installed path. Put `~/.local/bin` on PATH if necessary.

Restart or reload Codex's MCP connection after installation or updates.

## Daily use

1. In your project directory, start Claude:
   ```sh
   claude-live
   ```
   Accept Claude's development-channel prompt when shown. `claude-live --continue` and `claude-live --resume <id>` also work.
2. Open Codex in the same project and say **“Ask Claude to review this.”** Codex connects automatically if exactly one unpaired Claude conversation matches. If there are several choices or a pairing would change, it asks you to select one.
3. Either agent can now ask questions and reply. Ordinary terminal output is not forwarded; bridge tools carry the conversation.

To run another Claude conversation alongside the first:

```sh
CC_BRIDGE_LABEL=review claude-live
```

Matching uses the canonical Git working-tree root, or the canonical working directory outside Git. Subdirectories and symlinks match the same project; separate Git worktrees stay separate. You may explicitly select a conversation in another project.

## Reconnecting

- Resuming the **same conversation** preserves its pairing.
- `/clear`, a new conversation, or switching to another conversation updates the channel identity. The old pairing becomes invalid. Tell Codex **“Connect to Claude session review”** (using your label) to explicitly reconnect.
- During a transition, sends are refused rather than routed using an old identity. Delayed replies never move to a replacement conversation.
- Launch-scoped `SessionStart`/`SessionEnd` hooks track identity. Existing hooks and supplied `--settings` are retained. If hooks are disabled by policy or settings, the channel stays unavailable; restart with hooks enabled. Ordinary `claude` runs and restricted consultations do not install these hooks.
- If an old `claude-live` instance is still running after an update, restart it with `--resume` to enable lifecycle tracking.

## Troubleshooting

```sh
cc-bridge doctor       # capability, login, registration, PATH and socket checks
cc-bridge sessions     # available conversations and their project directories
cc-bridge status       # pairing state and recovery guidance
cc-bridge log -n 20    # messages and delivery status
```

`doctor` makes no model calls. Its socket check is local; a connected socket does not prove Channels was approved or that Codex is ready. Only a live question and reply verifies the full connection. Do not interpret `queued` as read or answered.

Repair an installation without reinstalling dependencies:

```sh
node bin/cc-bridge install
```

Manual pairing remains available while the Claude channel is running:

```sh
cc-bridge pair --claude review --codex <thread-uuid>
cc-bridge unpair --claude review
```

## Agent tools

Codex: `list_sessions`, `connect_claude(project_dir, session?)`, `send_to_claude`, `reply`, `bridge_status`, `pair_with_claude`, `consult_claude`, `list_consultations`.

Claude: `send_to_codex`, `reply`, `bridge_status`.

Codex supplies the calling thread identity through host metadata. `project_dir` only selects candidates; it is not an identity or authorization credential. An explicit session selection can replace a pairing, so agents must ask before choosing among candidates or changing an existing connection.

`consult_claude` starts a separate restricted Claude session with Read/Grep/Glob only. Follow-ups accept only bridge-created session IDs and keep the original working directory.

## Boundaries

Bridge messages request discussion or review; they do not grant permission to edit, run state-changing commands, or deploy. Your interactive agents retain their normal permissions. Existing logins and usage allowances apply.

Sessions are paired one-to-one using exact conversation IDs. Sends are asynchronous, never rerouted or automatically retried. Each message accepts one reply; exchanges are capped at 20 messages, and duplicate deliveries are rejected. Private state is stored under `~/.local/share/cc-bridge` (0700 directories, 0600 files); local sockets and launch state use the user runtime directory.

Custom Claude Channels remain a research preview. The launcher enables only the named development channel, not a tool-permission bypass. [Claude Channels reference](https://code.claude.com/docs/en/channels-reference).

## Tests

```sh
npm test
CC_BRIDGE_LIVE=1 node --test test/live.test.js
```

The standard suite uses isolated fake agents and real local sockets. The opt-in test uses Claude usage to verify actual consultation restrictions. Interactive round trips, resume and `/clear` must also be checked with real agents before claiming live integration is verified.
