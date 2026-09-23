# Live verification

Automated tests use fake agents. The steps below were checked by hand against real agents on 2026-09-23, before 0.4.0. Repeat them after changing the channel, discovery or lifecycle code.

Environment: Linux, Node 22.23.2, Claude Code 2.1.280, Codex 0.156.1.

- `CC_BRIDGE_LIVE=1 node --test test/live.test.js`: passed against real Claude; only read/search tools loaded and the requested file write did not occur.
- `npm run setup` completed using the lockfile. Repeating `cc-bridge install` succeeded without changing the existing registration; other configured MCP servers were kept.
- `cc-bridge doctor`: all checks passed outside the execution sandbox. The sandbox itself denies Unix-socket binding, which doctor reports correctly.
- Real Codex MCP `connect_claude` and `send_to_claude` reached an isolated Claude terminal. Claude's reply was received in the paired Codex conversation.
- Claude initiated a second question; Codex's MCP reply arrived in the same Claude terminal. Both agents reported receipt without acknowledgement loops.
- Exiting and resuming the same Claude conversation retained the pairing and conversation identity.
- Real `/clear` updated identity in the running channel. Discovery reported `conversation-changed`, automatic reconnection was refused, a stale send was rejected, and explicit reconnection bound the new conversation.

The temporary test pairing was removed and the test terminals closed. Model transcripts remain in the agents' normal history; bridge message evidence remains in the private bridge transcript. No live sessions are left running by these tests.

The initial Codex test used approval policy `never`, which refused the bridge call; rerunning with normal approval handling passed. The bridge does not bypass tool approvals.


## Handoff recovery and receipt semantics

Offline coverage lives in `test/reliability.test.js` and `test/bridge.test.js`. Before release, use the updated checkout on both sides for these interactive checks:

1. Send two requests to a fresh agent. Leave its approval prompts open beyond `start_timeout_seconds`. Verify one window, two original request IDs, and visible waiting age in `cc-bridge status`.
2. Approve the prompts and complete the exchange. Codex should show queue acceptance; Claude notifications should remain receipt-unconfirmed until a real reply. Never describe notification submission as a read receipt.
3. Close an agent before it connects. Verify no automatic reopening; `cc-bridge retry <message-id>` opens one replacement and preserves the waiting requests. Closing an established paired agent and sending a new request should resume that conversation.
4. Cancel an unclaimed request and verify it is never handed over. Switch a conversation during startup and verify old requests become dropped with content and reason, never rerouted.
5. Delay Claude's channel approval specifically. Check whether the host retains pre-approval notifications. Regardless of the observed result, retain the unconfirmed status until a reply; the transport itself supplies no receipt acknowledgement.

These checks use model quota and host approval prompts. Offline fake-agent tests cannot establish how the real host handles notifications before approval.
