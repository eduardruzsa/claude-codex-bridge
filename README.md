# Claude ⇄ Codex bridge

Let Claude Code and OpenAI Codex talk to each other on your machine. Say *"ask Codex to review this"* in Claude, or *"ask Claude …"* in Codex. The message goes to the other agent's session and the answer comes back the same way, with no copying between terminals. If the other agent isn't running, the bridge opens it in a new terminal.

Optionally, each agent can also [review the other's plans](docs/configuration.md#plan-review) before you see them.

> **Status:** Linux only. It relies on Claude Channels, which are a research preview in Claude Code.

## Requirements

- Linux, Node **22.23.2** or newer, npm, Git, `flock` (util-linux)
- Claude Code with Channels (tested with 2.1.280) and Codex with `codex queue` (tested with 0.156.1), both logged in
- A terminal launcher: `xdg-terminal-exec`, or any terminal you [configure](docs/configuration.md)

## Install

```sh
git clone https://github.com/eduardruzsa/claude-codex-bridge.git
cd claude-codex-bridge
npm run setup
cc-bridge doctor
```

Setup registers the bridge in Codex, installs the `cc-bridge` Claude plugin, and links `claude-live` and `cc-bridge` into `~/.local/bin` (make sure it's on your `PATH`). It is safe to run again and never overwrites anything that isn't its own. Keep the clone where it is, because Codex runs the bridge from there. Restart Codex afterwards.

No `xdg-terminal-exec`? Set your terminal before setup:

```sh
node bin/cc-bridge config set terminal '["kitty", "--directory", "{cwd}", "--title", "{title}"]'
```

**Update:** `git pull && npm ci && cc-bridge install`, then restart Codex and Claude.

## What you'll be asked to allow

**Claude: a development-channel flag.** Claude Code only loads a custom channel when started with `--dangerously-load-development-channels`. `claude-live` adds it for you, and the first time, Claude asks you to confirm. The flag enables only this channel. Claude still asks before tool calls as usual.

**Codex: the bridge's tools.** Codex asks before every MCP tool call, including each bridge message. To stop the prompts, add one line to the `cc-bridge` entry in `~/.codex/config.toml`:

```toml
[mcp_servers.cc-bridge]
# command and args as written by setup
default_tools_approval_mode = "approve"
```

Without it, bridge calls are refused under approval policy `never` (and in `codex exec`). With `approvals_reviewer = "auto_review"`, the automatic reviewer may reject messages that mention your repository. Allowing the tools only lets Codex send and read bridge messages; the Claude on the other end still asks you before it edits anything or runs commands.

## Use it

1. In your project, start Claude with `claude-live` (it accepts `--continue` and `--resume <id>`, like `claude`).
2. Say **"ask Codex to review this"**. If this conversation has no Codex yet, a new Codex opens in a terminal in the same directory. If its paired Codex isn't running, that conversation is reopened.
3. In Codex, say **"ask Claude …"**. It works the same way in reverse.

Only the bridge tools send anything; ordinary terminal output isn't forwarded. Each startup opens one window, and later messages wait for it.

Each Claude conversation gets a **label**: `claude`, then `claude-2`, `claude-3`, and so on for more sessions. Set one yourself with `CC_BRIDGE_LABEL=review claude-live`. To attach Codex to an existing conversation, tell it **"Connect to Claude session <label>"** (`cc-bridge sessions` lists them).

To use plain `claude`, add `alias claude="claude-live"` to your shell rc. Subcommands such as `claude mcp` pass through unchanged.

## When something goes wrong

```sh
cc-bridge doctor              # checks your setup; no model calls
cc-bridge status              # connections and waiting requests, with recovery hints
cc-bridge log -n 20           # recent messages and their delivery state
cc-bridge retry <message-id>  # restart a failed startup and hand the request over
```

"Queued" or "notification sent" means the message was handed over, not that it was read. Only a reply confirms it. See [docs/troubleshooting.md](docs/troubleshooting.md) for all the states, reconnecting after `/clear`, and manual pairing.

## Security model

- **Messages are requests, not permissions.** A bridge message never authorizes edits, commands or deploys, and both agents keep their normal approval settings.
- **Local and per-user.** Messages go over a Unix socket in a private (`0700`) directory, authenticated with a random token. Nothing listens on the network. Other users can't reach the bridge. Processes running as your own user (and root) can read the token and transcript and are trusted, just as they can read your agents' files.
- **Identity comes from the hosts, not the model.** Codex identifies the calling thread through host metadata. Claude pairings bind to the exact conversation ID.
- **No rerouting.** A message never moves to another conversation. After `/clear` or a switched conversation, waiting requests are recorded as dropped, not resent.
- **Read-only helpers.** `consult_claude` and the plan reviewers can only read and search files, with no MCP servers. If the Codex reviewer can't be isolated, it doesn't run.

## Uninstall

Close Claude and Codex, then run **one** of:

```sh
cc-bridge uninstall           # remove the Codex registration and hook, the Claude plugin and the links
cc-bridge uninstall --purge   # also delete pairings, transcript, token and config
```

It removes only what is recognisably the bridge's. To purge after a plain uninstall, run `node bin/cc-bridge uninstall --purge` from the clone. Then delete the clone.

## More

- [Configuration and plan review](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
