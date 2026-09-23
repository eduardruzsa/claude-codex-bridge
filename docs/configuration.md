# Configuration

Settings live in `~/.config/cc-bridge/config.json`. Every key is optional.

```sh
cc-bridge config                  # effective values and where each comes from
cc-bridge config init             # write the defaults (never overwrites)
cc-bridge config set <key> <value>
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
| `start_timeout_seconds` | `180` | How long before a startup is shown as waiting; never opens another window | |
| `consult_timeout_seconds` | `600` | Longest a `consult_claude` call may take | |
| `max_exchange_depth` | `20` | Messages allowed in one exchange | |

Environment variables win over the file. The path is fixed on purpose: Codex strips most environment variables from MCP servers, and the Claude plugin runs from a copy, so a file at a known path is what every part of the bridge can see. `CC_BRIDGE_CONFIG` points somewhere else (mainly for tests).

Changes apply on the next action. Restart the agents after changing `claude_bin`, `data_dir` or `runtime_dir`.

The consultation and plan-reviewer tool restrictions are deliberately not configurable; see the Security model in the [README](../README.md#security-model).

## Codex tool approval

Codex asks before every MCP tool call. Setting `default_tools_approval_mode = "approve"` on the `cc-bridge` entry in `~/.codex/config.toml` approves all of the bridge's tools. To keep one tool on prompt, for example `consult_claude`, which starts a separate Claude and uses your Claude quota, override it:

```toml
[mcp_servers.cc-bridge]
# command and args as written by setup
default_tools_approval_mode = "approve"

[mcp_servers.cc-bridge.tools.consult_claude]
approval_mode = "prompt"
```

## Plan review

When enabled, the other agent reviews a plan before it reaches you:

- **Claude Code plan mode** (`review_claude_plans`): when Claude calls `ExitPlanMode`, a read-only `codex exec` reviews the plan. If Codex has findings, Claude revises the plan once, adds a short "Codex review" section (what changed, and where it disagrees), and presents it.
- **Codex plan mode** (`review_codex_plans`): when Codex ends a turn with a plan, a restricted read-only `claude -p` reviews it, and Codex revises it the same way with a "Claude review" section.

"LGTM" goes straight through with a note. A reviewer failure or timeout never blocks: the plan passes with a warning. Each review uses the other agent's normal quota and usually takes a minute or two. Once enabled, it applies to every session, not only `claude-live`.

To turn it on:

```sh
cc-bridge config set plan_review.review_claude_plans true
cc-bridge config set plan_review.review_codex_plans true
cc-bridge install        # adds the Codex Stop hook
```

The Claude hook ships in the plugin and follows the config right away. The Codex side needs a `Stop` hook in `~/.codex/hooks.json`, which `cc-bridge install` adds only while `review_codex_plans` is on (and removes when it is off). Codex asks you once to trust the new hook ("hooks need review", or run `/hooks`); until then, Codex plans go unreviewed. `cc-bridge doctor` shows the trust status.

`CC_BRIDGE_PLAN_REVIEW=0` or `=1` overrides the config for one session, but `=1` can't activate a Codex hook that isn't installed.
