# Changelog

## 0.5.0

- Requests for an agent that is still starting get an id and timestamp at once, and survive a slow approval, an interrupted handover or a closed window. After a conversation change they are recorded as dropped, never rerouted.
- One window per startup: the launch is reserved before the terminal opens and tracked by a wrapper inside it, so a slow start no longer opens a second window.
- `cc-bridge status` shows waiting requests and their age (`--verbose` for full ids). New `cc-bridge retry <id>` and `cc-bridge cancel <id>`.
- Delivery states say what is known: "queued to Codex", and "notification sent; receipt unconfirmed" for Claude until a real reply.
- `pair_with_claude` hands over pending messages like `connect_claude`.

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
