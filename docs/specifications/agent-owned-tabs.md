# Agent-owned browser tabs (candidate)

OWL Runtime's managed Chrome browser assigns a separate Playwright Page to each execution owner (session or durable Task). A user can select another tab while an agent clicks, types, reads and screenshots the agent's pinned page. Logical `web.session(use_tab)` never calls `bringToFront`, and newly created agent-owned tabs use Chromium CDP `Target.createTarget({background:true})`.

## Safety and behavior

- `web.session(tabs)` reports `active` relative to the calling owner, not whichever tab the human is currently viewing.
- An owner cannot claim a page already assigned to another live owner.
- `web.session(close)` under an agent owner closes only an OWL-created tab assigned to that owner. A manually adopted user tab is not forcibly closed. Unscoped (system) close keeps its previous whole-browser behavior.
- Managed browser headless/visible mode changes fail closed while owner tabs are active, avoiding accidental global restarts.
- The managed Chrome profile stays separate from personal Chrome. Browser cookies/passwords are never copied silently.
- Runtime Request/Task execution contexts supply ownership; the `runtime:system`/direct-browser contract keeps legacy behavior. A new session may need to explicitly re-bind a tab after a transport identity changes.
- This is a P0 isolation improvement, **not** permission to post, change account settings, make purchases, or perform destructive remote actions without the normal Runtime authorization and verification.

## Verification

`node_modules/.bin/tsx scripts/verify-browser-owner-tabs.ts` runs an isolated localhost site and temporary headless Chrome profile: two owners fill different fields, capture separate screenshots, cannot hijack each other's active tab, and one can close its tab without closing the other's or the existing page. Typecheck, `npm run verify:browser-postconditions`, and `npm run verify:session-adapters` should also pass.

## Follow-up

To match attached-Chrome UX more closely, implement an explicit opt-in tab binding UX with durable tab identity across transport reconnects and per-site consent. This patch does not attach to a personal Chrome profile or change the human's tabs automatically.
