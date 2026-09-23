# Changelog

## 0.4.0 — first public release

- Config file `~/.config/cc-bridge/config.json` for every setting (`cc-bridge config`, `config init`, `config set`). Existing `CC_BRIDGE_*` environment variables still work and take precedence.
- Plan cross-review is opt-in (`plan_review.review_claude_plans`, `plan_review.review_codex_plans`). The Codex `Stop` hook is installed only when Codex plan review is enabled.
- A plan reviewer that doesn't finish in `plan_review.timeout_seconds` is killed, and the plan passes with a note.
- `cc-bridge uninstall [--purge]`.
- The terminal launcher check honours a custom `terminal`.
- MIT license. One version across the package, the plugin and the MCP servers.

## 0.3.x

Private development: two-way messaging, on-demand start of the other agent, session discovery, `/clear` tracking, plan cross-review.
