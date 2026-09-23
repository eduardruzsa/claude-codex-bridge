# Claude ⇄ Codex bridge

Let Claude Code and OpenAI Codex talk to each other on your machine. Say *"ask Codex to review this"* in Claude, or *"ask Claude …"* in Codex, and the message goes straight to the other agent's session. The answer comes back the same way, so you don't copy text between terminals. If the other agent isn't running, the bridge opens it in a new terminal.

Optionally, each agent can also review the other's plans before you see them.

```
 Claude Code ──(Claude Channel, cc-bridge plugin)──┐
      ▲                                            │ Unix socket (user-only)
      │ channel events                             ▼
      └──────────── cc-bridge ────────── codex queue ──▶ Codex
                         ▲                                 │
                         └──── cc-bridge MCP server ◀──────┘
```

- **Claude → Codex:** the `cc-bridge` Claude plugin is a [Claude Channel](https://code.claude.com/docs/en/channels-reference). Its `send_to_codex`/`reply` tools hand messages to `codex queue --thread <id>`.
- **Codex → Claude:** a Codex MCP server (`send_to_claude`, `reply`, …) writes to the live Claude session's private socket, and the message appears in Claude as a channel event.
- Sessions pair one-to-one by exact conversation ID, and the pairing survives resume.

> **Status:** works day to day on Linux, but Claude Channels are a research preview. The bridge needs Claude Code's `--dangerously-load-development-channels` flag. That flag only enables this one channel; it doesn't bypass tool permissions.

## Requirements

- Linux (the bridge uses `/proc` and abstract Unix sockets)
- Node **22.23.2** or newer, npm, Git, `flock` (util-linux)
- Claude Code with Channels and `--restricted` (tested with 2.1.280), logged in
- Codex with `codex queue` (tested with 0.156.1), logged in
- A terminal launcher: `xdg-terminal-exec` by default, or any terminal set in the config

## Install

```sh
git clone https://github.com/eduardruzsa/claude-codex-bridge.git
cd claude-codex-bridge
npm run setup
```

Setup installs the locked dependencies and then:

1. registers the `cc-bridge` MCP server in Codex
2. installs the `cc-bridge@cc-bridge` Claude plugin (this repository is its marketplace)
3. links `claude-live` and `cc-bridge` into `~/.local/bin` (make sure it's on `PATH`)

It is safe to run again: other MCP servers and hooks are kept, and it never overwrites a file or registration that isn't its own. Keep the repository where you cloned it, because Codex runs the MCP server from there. Restart Codex afterwards.

Setup checks for a terminal launcher. Without `xdg-terminal-exec`, set your terminal first, from the clone:

```sh
node bin/cc-bridge config set terminal '["kitty", "--directory", "{cwd}", "--title", "{title}"]'
npm run setup
```

Then run `cc-bridge doctor`.

### What you'll be asked to allow

**Claude: a development-channel flag.** Custom Claude Channels are a research preview, so Claude Code only loads one when it is started with `--dangerously-load-development-channels`. `claude-live` passes it for you (`claude --dangerously-load-development-channels plugin:cc-bridge@cc-bridge`). The first time, Claude asks you to confirm loading the development channel. The flag enables only this channel. It does not skip tool permissions, and your Claude session keeps asking for approvals as usual.

**Codex: approving the cc-bridge tools.** Codex asks before every MCP tool call, including the bridge's `send_to_claude` and `reply`. To stop being asked, allow the bridge's tools in `~/.codex/config.toml`, under the entry setup created:

```toml
[mcp_servers.cc-bridge]
# command and args as written by setup
default_tools_approval_mode = "approve"

# optional: keep asking before consultations, which use your Claude quota
[mcp_servers.cc-bridge.tools.consult_claude]
approval_mode = "prompt"
```

Without this:
- With approval policy `never` (and in `codex exec`, which defaults to it), every bridge call is refused.
- With `approvals_reviewer = "auto_review"`, the automatic reviewer may reject a message whose text includes details from your repository, because it can't verify who receives it. Answer the prompt yourself, or allow the tools as above.

Allowing them only lets Codex send and read bridge messages. The Claude on the other end still asks you before it edits anything or runs commands.

**Updating:** `git pull && npm ci && cc-bridge install`, then restart Codex and any `claude-live` sessions.

## Daily use

1. In your project, start Claude with the channel enabled:
   ```sh
   claude-live            # also: claude-live --continue, claude-live --resume <id>
   ```
   Accept Claude's development-channel prompt when it appears (see [What you'll be asked to allow](#what-youll-be-asked-to-allow)).
2. In Claude, say **"ask Codex to review this"**. You don't need to open Codex first:
   - **This conversation has no Codex connection:** a *new* Codex conversation opens in a terminal in the same directory and receives the message. Approve its cc-bridge tool calls there, unless you allowed them in the Codex config.
   - **Its paired Codex thread isn't running:** that thread is reopened (`codex resume`) and the message waits for it.
3. It works the same in the other direction. In Codex, say **"ask Claude …"**:
   - **No connection:** a *new* Claude conversation opens with `claude-live` in Codex's directory, pairs itself and receives the message.
   - **The paired Claude conversation isn't running:** it is reopened (`claude-live --resume <id>`).
4. Both agents can ask and answer. Their ordinary terminal output is not forwarded; only the bridge tools send anything.

To use plain `claude`, add `alias claude="claude-live"` to your shell rc. Subcommands (`claude mcp`, `claude update`, `--version`, …) pass through unchanged. Plain `codex` works as is.

Each start opens one terminal. More messages join the same startup, even if approval takes longer than the startup timeout. Requests keep their original IDs and timestamps. Closing the window does not automatically reopen it; waiting requests remain available for recovery. To attach Codex to an *existing* Claude conversation, tell it **"Connect to Claude session <label>"** (`cc-bridge sessions` lists them).

Each running Claude conversation has a **label** (`claude` by default). Run as many `claude-live` sessions as you like: when `claude` is taken, the next one gets `claude-2`, then `claude-3`, and so on. A resumed conversation gets back the label it is paired under, if that label is free. To choose the name yourself, set it explicitly; an explicit label is never swapped for another one:

```sh
CC_BRIDGE_LABEL=review claude-live
```

Matching uses the Git working-tree root (or the working directory outside Git), so subdirectories and symlinks count as the same project and separate worktrees stay separate.

The plugin loads in every Claude session but stays dormant (no tools, no socket) unless Claude was started with `claude-live`.

## Configuration

Settings live in `~/.config/cc-bridge/config.json`. Every key is optional.

```sh
cc-bridge config                  # effective values and where each comes from
cc-bridge config init             # write the defaults (never overwrites)
cc-bridge config set plan_review.review_claude_plans true
```

| Key | Default | Meaning | Env override |
|---|---|---|---|
| `claude_bin` | `"claude"` | Claude Code command | `CC_BRIDGE_CLAUDE_BIN` |
| `codex_bin` | `"codex"` | Codex command | `CC_BRIDGE_CODEX_BIN` |
| `terminal` | `null` | Terminal that opens a missing agent, as argv, e.g. `["kitty", "--directory", "{cwd}", "--title", "{title}"]`. `null` uses `xdg-terminal-exec` | `CC_BRIDGE_TERMINAL` (space-separated) |
| `default_label` | `"claude"` | Label of a `claude-live` session; when taken, the next free `<label>-2`, `<label>-3`, … is used | `CC_BRIDGE_LABEL` (exact label, no fallback) |
| `data_dir` | `null` | Pairings, transcript, token; use a directory only the bridge uses. `null`: `~/.local/share/cc-bridge` | `CC_BRIDGE_DATA_DIR` |
| `runtime_dir` | `null` | Sockets and launch state; use a directory only the bridge uses. `null`: `$XDG_RUNTIME_DIR/cc-bridge` | `CC_BRIDGE_RUNTIME_DIR` |
| `plan_review.review_claude_plans` | `false` | Codex reviews Claude's plans | `CC_BRIDGE_PLAN_REVIEW=0/1` |
| `plan_review.review_codex_plans` | `false` | Claude reviews Codex's plans (run `cc-bridge install` after changing) | `CC_BRIDGE_PLAN_REVIEW=0/1` |
| `plan_review.timeout_seconds` | `480` | Longest a plan review may take (max 540) | |
| `start_timeout_seconds` | `180` | How long before startup is shown as waiting; does not launch another window | |
| `consult_timeout_seconds` | `600` | Longest a `consult_claude` call may take | |
| `max_exchange_depth` | `20` | Messages allowed in one exchange | |

Environment variables win over the file. The path is fixed on purpose: Codex strips most environment variables from MCP servers, and the Claude plugin runs from a copy, so a file at a known path is what every part of the bridge can see. `CC_BRIDGE_CONFIG` points somewhere else (mainly for tests). Changes apply on the next action. Restart the agents after changing `claude_bin`, `data_dir` or `runtime_dir`.

Some things are deliberately not configurable: the consultation and plan-reviewer tool restrictions described under [Security model](#security-model).

## Plan review (optional)

When enabled, the other agent reviews a plan before it reaches you:

- **Claude Code plan mode** (`review_claude_plans`): when Claude calls `ExitPlanMode`, a read-only `codex exec` reviews the plan. If Codex has findings, Claude revises the plan once, adds a short "Codex review" section (what changed, and where it disagrees), and presents it.
- **Codex plan mode** (`review_codex_plans`): when Codex ends a turn with a plan, a restricted read-only `claude -p` reviews it, and Codex revises it in the same way with a "Claude review" section.

"LGTM" goes straight through with a note. A reviewer failure or timeout never blocks: the plan passes with a warning. **Each review uses the other agent's normal quota** and usually takes a minute or two. It applies to every session once enabled, not only `claude-live`.

To turn it on:

```sh
cc-bridge config set plan_review.review_claude_plans true
cc-bridge config set plan_review.review_codex_plans true
cc-bridge install        # adds the Codex Stop hook
```

The Claude hook ships in the plugin and follows the config right away. The Codex side needs a `Stop` hook in `~/.codex/hooks.json`, which `cc-bridge install` adds only while `review_codex_plans` is on (and removes when it is off). **Codex asks you once to trust the new hook** ("hooks need review", or run `/hooks`); until then, Codex plans go unreviewed. `cc-bridge doctor` shows the trust status. `CC_BRIDGE_PLAN_REVIEW=0` or `=1` overrides the config for one session, but `=1` can't activate a Codex hook that isn't installed.

## Security model

- **Messages are requests, not permissions.** A bridge message asks for discussion or review. It never grants permission to edit, run state-changing commands or deploy. Both interactive agents keep their normal approval settings; the bridge bypasses none of them.
- **Local and per-user.** Messages travel over a Unix socket in a `0700` runtime directory, authenticated with a random token in a `0700`/`0600` data directory. Nothing listens on the network. Other users on the machine can't reach the bridge, but processes running as **your** user (and root) can read the token and transcript and are trusted, as they are for your agents' own files.
- **Identity from the hosts, not the model.** Codex supplies the calling thread through host metadata (`_meta.threadId`), which is cross-checked against the rollout files the Codex process has open. Claude pairings bind to the exact conversation ID. `project_dir` only narrows the candidates; it is not a credential.
- **No rerouting.** A message never moves to another conversation. After `/clear` or a switched conversation, old pending requests are recorded as dropped; new exchanges use a fresh conversation. Handoffs are not automatically retried, each message accepts one reply, and an exchange is capped at `max_exchange_depth`.
- **Read-only helpers.** `consult_claude` and the Claude plan reviewer run `claude -p --restricted` with Read/Grep/Glob only and no MCP servers. The Codex plan reviewer runs `codex exec` in a read-only sandbox with hooks, plugins, apps and every configured MCP server disabled. If it can't be isolated, it doesn't run.

## Reconnecting

- Resuming the **same conversation** keeps its pairing.
- `/clear`, a new conversation, or switching conversations changes the channel identity and invalidates the old pairing. Tell Codex **"Connect to Claude session <label>"** to reconnect.
- The plugin's `SessionStart`/`SessionEnd` hooks track the conversation for each `claude-live` process and do nothing in other sessions. If hooks are disabled, the channel uses the conversation ID Claude was started with and won't follow `/clear`.

## Troubleshooting

```sh
cc-bridge doctor       # config, capabilities, logins, registration, PATH and socket checks
cc-bridge sessions     # available conversations and their project directories
cc-bridge status       # startup, waiting requests, connection state and recovery guidance
cc-bridge status --verbose # include full session identifiers
cc-bridge log -n 20    # messages, delivery status and plan reviews
```

`doctor` makes no model calls, and a passing socket check doesn't prove the channel was approved. Only a real question and reply does. `queued to Codex` means its queue accepted the message, not that the agent read it. Claude channel notifications have no receipt acknowledgement: `notification sent; receipt unconfirmed` is intentional. Only an actual reply changes a request to `replied`. Approve the channel prompt before relying on notifications; a notification submitted before approval may not reach the agent.

Every waiting request appears in `status` and `log`, including its request ID. If an agent exits or startup fails, the recovery hint provides one command:

```sh
cc-bridge retry <message-id>    # recover startup for the original destination
cc-bridge cancel <message-id>   # cancel a request before handover is claimed
```

Retry refuses to open a duplicate while the agent wrapper is running. A retry of an already queued Codex message only reopens its original conversation; it does not queue the message again. An explicit retry of an unconfirmed Codex queue attempt may duplicate a request, because that queue provides no deduplication. Claude deduplication prevents resubmitting a notification already recorded as sent; if no reply arrives, ask the agent to send a new request. Cancellation cannot recall a notification or queued message.

Interrupted handovers stay visible as unconfirmed. Old requests are never silently reassigned after a conversation change. The launch wrapper records the agent process separately from the terminal launcher, so an exited launcher does not trigger another window. Legacy pending records are upgraded when processed; restart both agents after updating so they use the same pending format.

Manual pairing while the Claude channel is running:

```sh
cc-bridge pair --claude review --codex <thread-uuid>
cc-bridge unpair --claude review
```

## Uninstall

Close Claude and Codex first, so nothing recreates the bridge's state. Then run **one** of:

```sh
cc-bridge uninstall           # Codex MCP server + hook, Claude plugin + marketplace, ~/.local/bin links
cc-bridge uninstall --purge   # the same, plus pairings, transcript, token, sockets and the config file
```

It removes only entries that are recognisably the bridge's and reports anything it left alone. `--purge` deletes files by the bridge's own name patterns and keeps any subdirectory that holds something else. If you uninstalled without `--purge` and want the data gone too, run `node bin/cc-bridge uninstall --purge` from the clone (the `cc-bridge` link is gone by then). Then delete the cloned repository.

## Agent tools

- **Codex:** `list_sessions`, `connect_claude(project_dir, session?)`, `send_to_claude`, `reply`, `bridge_status`, `pair_with_claude`, `consult_claude`, `list_consultations`
- **Claude:** `send_to_codex`, `reply`, `bridge_status`

An explicit session selection can replace a pairing, so agents are instructed to ask before choosing among candidates or changing a connection.

## Development

```sh
npm test                                      # fake agents, real local sockets
CC_BRIDGE_LIVE=1 node --test test/live.test.js # real Claude; uses a little quota
```

Interactive round trips, resume and `/clear` need real agents; see [docs/verification.md](docs/verification.md). Test-only environment variables: `CC_BRIDGE_ACTIVE`, `CC_BRIDGE_CLAUDE_PROC`, `CC_BRIDGE_LIFECYCLE_DIR`, `CC_BRIDGE_LIVE`, `CC_BRIDGE_CONFIG`.

## License

[MIT](LICENSE)
