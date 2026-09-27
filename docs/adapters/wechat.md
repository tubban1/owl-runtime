# AgentOS Runtime Persistent WeChat Session Adapter

Status: **v0.9.10 foundation**

The WeChat Session Adapter turns a GUI-only WeChat conversation into a durable Session Endpoint usable by Persistent Loop.

```text
Persistent Loop
      |
      v
Generic Session Endpoint
      |
      v
wechat_session_...
      |
      +--> background probe
      |      CGWindow capture
      |      Apple Vision OCR
      |      no app activation
      |
      +--> capture_latest
      |      background when bound chat is already visible
      |      short foreground fallback when necessary
      |
      +--> send
             foreground transaction
             verify contact
             send
             durable receipt
             restore previous app
```

## Low-interruption mode

Default suggested polling interval is 30 seconds.

Binding and probing first try the background path. If the currently visible WeChat conversation header already matches the requested contact, binding completes with zero focus interruption. A probe never activates WeChat. The native Computer MCP Helper finds the WeChat process' primary CGWindow, captures it by window ID, and performs Apple Vision OCR.

If the OCR header still matches the bound contact and the visible conversation digest has not changed, the Runtime does nothing else.

If the bound conversation is not active, `capture_latest` can perform a short foreground transaction:

1. remember the current frontmost application
2. activate WeChat
3. navigate to the bound contact
4. OCR-verify the chat header
5. capture the latest visible text
6. restore the previous application

Sending always uses the foreground transaction because it creates an external UI side effect.

## Why OCR instead of Accessibility

Current macOS WeChat exposes only a very small Accessibility tree and does not reliably expose contact/message text. The Adapter therefore does not pretend that Accessibility can support reliable background monitoring.

Window capture + native OCR is the background perception path; Accessibility/input remains available for controlled foreground actions.

## Session state

Encrypted storage defaults to:

```text
~/.computer-mcp/wechat-sessions/
~/.computer-mcp/wechat-session.key
```

A binding retains:

- exact contact name
- suggested poll interval
- OCR languages
- observed and delivered digests
- last visible/reply text
- turn counter
- pending-send state
- last send receipt
- focus duration metadata

## Probe versus capture

`probe` observes change but does not consume it.

`capture_latest` marks the current conversation digest as delivered.

This is important for persistent loops: repeated 30-second probes can notice a pending change without losing it before the next phase consumes the message.

## Crash-safe send

Before typing an external message, the Runtime persists `pendingSend`.

If execution is interrupted after the message may have been sent but before the receipt is committed, automatic resend is blocked. The state must be explicitly resolved as `sent` or `not_sent`.

Duplicate text is also protected by the durable send receipt.

## Unified loop endpoint

WeChat uses the same Session Phase abstraction as browser agents.

```text
session_...          -> ChatGPT / Antigravity
wechat_session_...   -> WeChat contact
```

The Loop Controller can therefore relay between WeChat and a browser agent without a WeChat-specific loop engine.

## Runtime skill

`wechat.session` supports:

```text
contract
bind
identify
probe
capture_latest
send
resolve_pending
list
delete
```

## macOS permissions

Background capture/OCR requires Computer MCP Helper permission for Screen & System Audio Recording. Foreground navigation/send also requires Accessibility.

Reinstalling or re-signing the Helper may cause macOS to require those permissions to be granted again.

## Verification

`npm run verify:wechat-session` validates background-probe semantics with OCR fixtures without taking real focus or sending a real message.

The native Helper source is additionally syntax-checked by `npm run verify:macos-helper`. A full helper build is performed by `scripts/install-macos-helper.sh`.
