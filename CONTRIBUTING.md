# Contributing

Thanks for helping. Bug reports, fixes and docs improvements are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Security problems go through [private advisories](https://github.com/eduardruzsa/claude-codex-bridge/security/advisories/new), not issues (see [SECURITY.md](SECURITY.md)).

## Setup

```sh
git clone https://github.com/eduardruzsa/claude-codex-bridge.git
cd claude-codex-bridge
npm ci
npm test
```

`npm test` uses fake `claude`/`codex` binaries and temporary directories, so it needs neither agent and never touches your real configuration. You only need a real install (`npm run setup`) to try changes end to end.

## Pull requests

1. Keep each PR to one change, and add or update tests for it.
2. `npm test` must pass (CI runs it on Node 22, the oldest supported, and on the latest LTS).
3. Match the surrounding style: ES modules, no build step, no new runtime dependencies without discussion.
4. If you change the channel, discovery, lifecycle or launch code, repeat the relevant checks in [docs/verification.md](docs/verification.md) with real agents and say so in the PR.
5. Update the README, `config.example.json` and `CHANGELOG.md` when you change user-facing behavior or settings.

The design rules that shouldn't loosen: messages are never rerouted or retried, identity comes from the hosts (not from what a model says), and consultations and reviewers stay read-only.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
