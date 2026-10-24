# OWL managed browser: explicit session tab handoff (v1)

This is a scoped transfer between two **known Runtime execution session IDs** in the OWL-managed Chrome profile. It is not automatic account reauthorization, tab attachment to personal Chrome, or a bypass for Runtime action approvals.

## Authorized flow

1. The **current tab owner** calls `web.session(handoff_prepare)` with `target_session_id` and optional `ttl_seconds` (15–180, default 120). The tab must already be open at an HTTP(S) origin. A 256-bit random single-use `token` and a stable Chromium `tabId` are returned.
2. Transfer the token privately to the named successor. Treat the token as a credential; never publish it in a website, issue, screenshot, or telemetry.
3. The successor Session calls `web.session(handoff_claim)` with `token`. Runtime verifies the caller's session ID, token, expiry, current tab owner, stable target ID and origin, then moves the same Playwright Page to the successor atomically. No tab activation or navigation is performed.
4. The successor can continue the page using normal authorized OWL browser operations and verify the result by screenshot.

## Safety

- The token is valid only in the **same live Runtime** and is **not persisted**. It is single-use, expires in 3 minutes maximum and is stored in memory by hash.
- Claims from any other session, after tab close, after origin change, or after Runtime restart fail closed.
- `token` is redacted from tool audit **inputs**; avoid copying the returned secret into logs or general messages.
- `tabId` by itself is never sufficient to authorize claim.
- Original session must issue the grant before losing access. For abrupt disconnection without an outstanding grant, automatic takeover is deliberately NOT provided: future Desktop UX must obtain human confirmation after establishing the device/account identity.
- Handoff does not authorize external effects: browser typing, clicking, uploading, and other consequential actions still pass through OWL Runtime approvals and result verification.
- Cross-origin navigation is only blocked while a pending handoff is outstanding. Following a successful claim, normal site navigation is governed by Runtime authorization.

## Tests

`npx tsx scripts/verify-browser-owner-tabs.ts` exercises two owner-isolated tabs and independent screenshots, successful transfer, wrong successor, forged token, replay, origin change, expiration, tab close, and audit token redaction.

No user browser is modified by the fixture: it uses a separate temporary Chrome profile and localhost HTTP fixture.
