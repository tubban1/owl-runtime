# AgentOS Runtime Session Adapter Contract

Status: **v0.9.9 foundation**

v0.9.9 makes browser-based AI sessions durable Runtime objects instead of relying on naked coordinates or whichever tab happens to be active.

Supported adapters:

```text
chatgpt
antigravity
generic-browser
```

Control is exposed through the existing L2 Skill:

```text
runtime.session
```

No new top-level MCP tool is required.

## Contract

A session binding persists:

- adapter identity
- exact conversation URL and title
- normalized session fingerprint
- prompt/message selectors
- busy/generation markers
- last capture digest
- last send digest
- turn counter
- send receipt
- unresolved pending-send state

Default encrypted storage:

```text
~/.computer-mcp/sessions/
~/.computer-mcp/session.key
```

## Operations

`runtime.session` supports:

```text
adapters
bind
identify
capture_latest
send
resolve_pending
rebind
list
delete
```

A binding never silently jumps to another conversation if the expected exact conversation URL disappears. Rebinding is explicit.

## Capture

`capture_latest` verifies the session fingerprint, checks generation/busy markers and uses the adapter's assistant-message selector to capture the last matching message. ChatGPT defaults to:

```text
[data-message-author-role="assistant"]
```

The browser snapshot Primitive now accepts optional `selector` and `last` fields, so this remains an extension of the existing `web.query(snapshot)` operation rather than a new L1 Primitive.

## Crash-safe send receipt

A model-to-model send is an external side effect.

Before sending, the Runtime writes a durable `pendingSend` record. After a successful send it clears the pending state and writes the turn receipt. If the Runtime stops in between those points, the session becomes uncertain and automatic replay is blocked.

The operator can inspect the target session and explicitly resolve the pending send as:

```text
sent
not_sent
```

This prevents a restart from accidentally duplicating a model turn.

## Browser persistence

The managed browser now uses a stable default Runtime profile:

```text
~/.computer-mcp/browser-profiles/default
```

This allows cookies/authenticated sessions to survive Runtime restarts. `BROWSER_PROFILE_DIR` can override it.

`web.session` is now the canonical home of tab state:

```text
tabs
use_tab
new_tab
close
```

The old `web.act(use_tab)` path is retained as a deprecated compatibility alias.

## Durable multi-agent relay

`runtime.loop` phases can now be either Primitive graphs or Session Adapter operations.

A ChatGPT ↔ Antigravity relay can be expressed as:

```text
capture_chatgpt
  capture_latest
  advance_when changed=true

send_antigravity
  text={{loop.lastOutput.reply}}

capture_antigravity
  capture_latest
  advance_when changed=true

send_chatgpt
  text={{loop.lastOutput.reply}}

repeat
```

Nested carry references such as `{{loop.lastOutput.reply}}` and `{{loop.phase.capture_antigravity.reply}}` are supported.

## Antigravity DOM overrides

Antigravity selectors can be supplied at bind time or through:

```text
ANTIGRAVITY_URL_PATTERN
ANTIGRAVITY_INPUT_SELECTOR
ANTIGRAVITY_SEND_SELECTOR
ANTIGRAVITY_MESSAGE_SELECTOR
ANTIGRAVITY_BUSY_MARKERS
```

This isolates changing product DOM details from the Session Adapter contract.

## Verification

`npm run verify:session-adapters` starts two local agent pages, binds them as distinct ChatGPT and Antigravity sessions, and runs a real four-phase Persistent Loop from ChatGPT → Antigravity → ChatGPT. It verifies fingerprints, exact last-message capture, cross-session carry, duplicate receipts and interrupted-send freeze behavior.
