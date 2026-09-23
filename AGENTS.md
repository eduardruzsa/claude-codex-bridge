# AGENTS.md

Instructions for coding agents working on this repository. Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

A local, two-way bridge between Claude Code and Codex. Linux only: it relies on `/proc` and abstract Unix sockets.

- **Claude side:** a Claude Code plugin (this repository is its marketplace). `claude-channel.js` is an MCP server with the `claude/channel` capability. It stays dormant unless Claude was started through `bin/claude-live`.
- **Codex side:** `codex-mcp.js`, an MCP server registered with `codex mcp add`. Messages to Codex go through `codex queue --thread <id>`.
- **CLI:** `bin/cc-bridge` handles install, uninstall, doctor, config, status, log, retry and cancel.

## Layout

| Path | Role |
|---|---|
| `claude-channel.js` | Claude channel server: socket, label choice, pending adoption, `send_to_codex`/`reply` |
| `codex-mcp.js` | Codex MCP server: `send_to_claude`, `connect_claude`, `consult_claude`, … |
| `bin/claude-live` | `claude --dangerously-load-development-channels plugin:cc-bridge@cc-bridge` wrapper |
| `bin/agent-launch.js` | Runs inside a launched terminal and tracks the agent process |
| `bin/plan-review`, `bin/lifecycle-hook.js`, `bin/plugin-start` | Hook and plugin entry points (`hooks/hooks.json`, `.mcp.json`) |
| `lib/config.js` | The config file schema; no imports from the rest of `lib/` |
| `lib/common.js` | Paths, pairings, transcript, socket protocol |
| `lib/pending.js`, `lib/launch-state.js`, `lib/recovery.js`, `lib/store.js` | Waiting requests, launch reservations, retry, locked JSON stores |
| `lib/launch.js` | Opening terminals, and the environment a launched agent gets |
| `lib/admin.js` | install, uninstall, doctor |
| `test/` | `node:test` suites that use fake `claude`, `codex` and terminal binaries |

## Commands

```sh
npm ci
npm test                                             # the full suite, about 15 s
node --test test/config.test.js                      # one file
node --test --test-name-pattern='label' test/ux.test.js
```

Wrap long runs in `timeout 300`: a failing assertion in `test/bridge.test.js` can leave MCP clients open, and the runner then hangs instead of exiting.

Don't run `test/live.test.js` (`CC_BRIDGE_LIVE=1`), `npm run setup` or `cc-bridge install` unless the user asks. They use real Claude quota, or change the user's Claude and Codex configuration.

## Rules that must hold

These are the bridge's safety properties. Changes that weaken them need an explicit decision from the maintainer.

- **Messages are requests, not permissions.** Nothing a bridge message says can bypass either agent's approval settings.
- **No rerouting, no silent retries.** A message for one conversation is never delivered to another. After a conversation change it is recorded as dropped, with the reason.
- **Identity comes from the hosts.** Use Codex's `_meta.threadId` and Claude's conversation ID from `SessionStart` or the environment, never an ID a model supplies.
- **Helpers stay read-only.** Consultations and the Claude plan reviewer run `claude -p --restricted` with Read, Grep and Glob only. The Codex reviewer runs in a read-only sandbox with hooks, plugins, apps and all MCP servers disabled, and doesn't run if it can't be isolated.
- **A launched agent never inherits the launching agent's session.** `agentEnv()` in `lib/launch.js` strips `CLAUDE*` and `CODEX_*` session variables and keeps `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.
- **Private state stays private.** Data and runtime directories are `0700`, and files in them are `0600`. Never print or log the token.
- **Hooks never block the user.** A plan-review failure, timeout or broken config lets the plan through with a visible note.

## Tests

- Every suite isolates itself: temporary `CC_BRIDGE_DATA_DIR`, `CC_BRIDGE_RUNTIME_DIR` and `CC_BRIDGE_CONFIG`, a fake `CC_BRIDGE_TERMINAL`, `CC_BRIDGE_CLAUDE_PROC=none`, and a temporary `CODEX_HOME` or `HOME` wherever Codex or Claude files could be touched. New tests must do the same. Tests must never read or write the real `~/.codex`, `~/.claude` or `~/.config/cc-bridge`.
- For a bug fix, first write a test that fails on the old code, then fix it.
- For state-machine or race fixes, assert on the recorded events in the transcript rather than on timing.
- CI runs on Node 22 (the minimum, per `package.json` `engines`) and on the latest LTS. Keep both working.

## Conventions

- ES modules, no build step. The only runtime dependency is `@modelcontextprotocol/sdk`. Don't add another without asking.
- Match the surrounding code: small functions, and comments that explain why.
- **New setting:** add it to `SCHEMA` in `lib/config.js`, to `config.example.json` (a test checks the two match), and to `docs/configuration.md`.
- **User-facing change:** update `README.md` or `docs/`, and add a `CHANGELOG.md` entry.
- **Release:** bump `version` in both `package.json` and `.claude-plugin/plugin.json` (a test checks they match), then run `npm install --package-lock-only`.

## Git and pull requests

- `main` is protected. Work on a branch and open a pull request; merges are squash-only and need both CI jobs green. Never force-push to `main`.
- Write commit messages that say what changed and why. Keep one change per pull request.
