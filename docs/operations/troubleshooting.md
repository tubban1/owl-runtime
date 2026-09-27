# Troubleshooting

## Jarvis is not reachable

Check:

```bash
npm run status:production
```

Production should report a running `com.agentos.runtime` LaunchAgent and a healthy `/health` endpoint.

## Do I need `npm run dev`?

No for normal use.

Production runs from `~/.agentos/current/dist/server.js` under launchd.

Use `npm run dev` only while developing AgentOS itself. It defaults to port `8788` and a separate development state root, so it does not collide with the production service on `8787`.

## WORKSPACE_BUSY

Another durable Task, Process, Transaction, or explicit lease owns an overlapping workspace.

Inspect with `runtime.workspace status/list`. Prefer wait/handoff rather than forcing release unless you have verified the owner is stale.

If the owner is a raw `session:...` from the same visible ChatGPT conversation after a stream/network recovery, the MCP transport may have rotated. Session-only leases with no Task owner and no pinned process are reclaimable after disconnect, and stale active-but-idle sessions have a conservative timeout. Long interactive work should be promoted to durable Task/Process/Transaction ownership rather than relying on a raw transport session.

Do not use force release on Task-, Process-, or Transaction-owned leases merely because the chat UI reconnected.

## PROCESS_NOT_ORPHANED

A process claim was attempted while the original owner is still active. Claim is only for recovered/disconnected ownership cases.

## RUNTIME_SELF_IMMUTABLE

Production Runtime refused to mutate its own active release. Build and install a new release instead.

## Browser session verifier times out waiting for CDP

Recent Chrome versions or a busy macOS session can take tens of seconds before the DevTools endpoint becomes reachable. AgentOS defaults to a 60-second browser startup wait. Inspect provider status for `startupTimeoutMs` and `connectTimeoutMs`. Adjust `BROWSER_STARTUP_TIMEOUT_MS` or `BROWSER_CONNECT_TIMEOUT_MS` within the supported 5–120 second range. The session-adapter verifier prefers an isolated Chrome for Testing binary when available so tests do not depend on the user's normal Chrome profile or GUI App permissions.

## WeChat background OCR fails

Check macOS permissions for Computer MCP Helper:

- Accessibility
- Screen & System Audio Recording

## Development changes keep restarting tools

Do not run the active service from `tsx watch`. Keep production on launchd and, when needed, run an isolated development instance on a different port.
