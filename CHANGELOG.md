# Changelog

## 0.4.1

- An agent started by the bridge no longer inherits the starting agent's session environment. A Codex opened from Claude used to receive `CLAUDE_PROJECT_DIR`, Claude's session ids and its messaging token, which made Codex hooks behave as if they ran under Claude.
- README: what Claude and Codex ask you to allow, and how to stop Codex asking for every bridge tool call.

## 0.4.0 — first public release

- Config file `~/.config/cc-bridge/config.json` for every setting (`cc-bridge config`, `config init`, `config set`). Existing `CC_BRIDGE_*` environment variables still work and take precedence.
- Plan cross-review is opt-in (`plan_review.review_claude_plans`, `plan_review.review_codex_plans`). The Codex `Stop` hook is installed only when Codex plan review is enabled.
- A plan reviewer that doesn't finish in `plan_review.timeout_seconds` is killed, and the plan passes with a note.
- Several `claude-live` sessions at once: when the default label is taken, the next free one (`claude-2`, `claude-3`, …) is used, and a resumed conversation gets back the label it is paired under. An explicit `CC_BRIDGE_LABEL` is still exact.
- `cc-bridge uninstall [--purge]`. Purge deletes only the bridge's own file names.
- The terminal launcher check honours a custom `terminal`.
- CI on Node 22 (minimum) and the latest Node LTS.
- MIT license. One version across the package, the plugin and the MCP servers.

## 0.3.x

Private development: two-way messaging, on-demand start of the other agent, session discovery, `/clear` tracking, plan cross-review.
