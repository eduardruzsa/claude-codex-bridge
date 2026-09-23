# Security

cc-bridge runs locally with your user's permissions and relays messages between two AI agents, so bugs here can matter. Please report vulnerabilities privately through [GitHub security advisories](https://github.com/eduardruzsa/claude-codex-bridge/security/advisories/new), not in public issues.

Useful reports include: a way for **another local user** to send or read bridge messages, a way for a bridge message to trigger an action without the receiving agent's normal approval, a consultation or plan reviewer that can write files or reach MCP servers, and messages routed to the wrong conversation.

Out of scope: processes running as your own user or as root. They can read the bridge's token and transcript, just as they can read your agents' configuration and history, and are trusted by design.

The design assumptions are in the README under "Security model".
