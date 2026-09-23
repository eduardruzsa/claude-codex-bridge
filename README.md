# Claude ⇄ Codex bridge

Ask either agent to discuss or review something with the other, without copying messages between terminals.

## Setup

Requirements: Linux, Node **22.23.2 or newer**, Git, `flock` (util-linux), `xdg-terminal-exec` (or set `CC_BRIDGE_TERMINAL`), Claude Code with Channels and `--restricted`, a Claude login, and Codex with `codex queue`. Tested with Claude Code 2.1.280 and Codex 0.156.1. Linux is required for `/proc` and abstract sockets.

After cloning this repository, run from its directory:

```sh
npm run setup
```

Setup installs the locked dependencies, registers `cc-bridge` in Codex, installs the `cc-bridge@cc-bridge` Claude plugin (this repository is its local marketplace), and links `claude-live` and `cc-bridge` into `~/.local/bin`. It is safe to repeat: other MCP entries are preserved, and unrelated files or conflicting registrations are never overwritten. Keep the repository at its installed path. Put `~/.local/bin` on PATH if necessary.

Restart Codex after installation or updates. After `git pull`, run `cc-bridge install` again to update the Claude plugin.

The Claude side is a plugin, and its channel loads in every Claude session. It stays dormant, with no tools and no socket, unless Claude was started with `claude-live`. Custom Channels need a startup flag, and `claude-live` is just `claude --dangerously-load-development-channels plugin:cc-bridge@cc-bridge "$@"`.

## Daily use

1. In your project directory, start Claude:
   ```sh
   claude-live
   ```
   Accept Claude's development-channel prompt when shown. `claude-live --continue` and `claude-live --resume <id>` also work.
2. Say **“ask Codex to review this”**. You don't need to open Codex first:
   - **This conversation has no Codex connection:** a *new* Codex conversation opens in a terminal in the same directory. It connects and receives the message; approve its cc-bridge tool calls there.
   - **Its paired Codex thread isn't running:** that thread is reopened (`codex resume`) and the message waits for it.
3. It works the same the other way. In Codex, say **“ask Claude …”**:
   - **No connection:** a *new* Claude conversation opens with `claude-live` in Codex's directory, pairs itself and receives the message. Accept the channel prompt there.
   - **The paired Claude conversation isn't running:** it is reopened (`claude-live --resume <id>`).
4. Either agent can now ask questions and reply. Ordinary terminal output is not forwarded; bridge tools carry the conversation.

Each start opens one terminal. A second message sent while the other agent is still starting joins the first one instead of opening another window. To attach Codex to an *existing* Claude conversation instead, tell it **“Connect to Claude session <label>”** (`cc-bridge sessions` lists them).

To run another Claude conversation alongside the first:

```sh
CC_BRIDGE_LABEL=review claude-live
```

Matching uses the canonical Git working-tree root, or the canonical working directory outside Git. Subdirectories and symlinks match the same project; separate Git worktrees stay separate. You may explicitly select a conversation in another project.

## Plan review

Before a plan reaches you, the other agent reviews it. This works in every session, not only `claude-live`:

- **Claude Code plan mode:** when Claude calls `ExitPlanMode`, a read-only `codex exec` reviews the plan. If Codex has findings, Claude revises the plan once, adds a short "Codex review" section (what changed, and where it disagrees), and presents it.
- **Codex plan mode:** when Codex ends a turn with a `<proposed_plan>`, a restricted read-only `claude -p` reviews it. Codex then revises the plan in the same way, adding a "Claude review" section.
- "LGTM" passes straight through with a note. A reviewer failure never blocks: the plan passes with a warning.
- Each review takes about a minute or two and uses the other agent's normal usage.
- Turn it off for a session with `CC_BRIDGE_PLAN_REVIEW=0`.

`cc-bridge install` adds the Codex `Stop` hook to `~/.codex/hooks.json`, keeping your other hooks. The Claude hook ships in the plugin. **Codex asks you once to trust the new hook** ("hooks need review") the next time you open it; until you do, Codex plans go unreviewed.

## Reconnecting

- Resuming the **same conversation** preserves its pairing.
- `/clear`, a new conversation, or switching to another conversation updates the channel identity. The old pairing becomes invalid. Tell Codex **“Connect to Claude session review”** (using your label) to explicitly reconnect.
- During a transition, sends are refused rather than routed using an old identity. Delayed replies never move to a replacement conversation.
- The plugin's `SessionStart`/`SessionEnd` hooks track identity in a private directory for each Claude process. They do nothing in sessions without the channel. If hooks are disabled by policy or settings, the channel falls back to the conversation id Claude was started with, so it won't follow `/clear`. Restricted consultations load no plugins.
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
