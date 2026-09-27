# AgentOS Runtime Persistent Loop Controller

Status: **v0.9.9 foundation**

The Loop Controller is an orchestration layer above Persistent Tasks and the L1 Primitive ISA.

```text
L3 Planner
   |
L2 runtime.loop
   |
Persistent Loop State
   |
   +--> Primitive phase -> Persistent Task -> L1 ISA
   |
   +--> Session phase   -> Session Adapter -> L1 web/session primitives
   |
cross-phase carry / wait / change detection / next cycle
```

L1 remains a small capability boundary. Time, durable turn-taking and session identity stay in Runtime orchestration.

## Persistent state

Loop records are AES-256-GCM encrypted under:

```text
~/.computer-mcp/loops/
~/.computer-mcp/loop.key
```

The store is Runtime-owned and is not part of the general filesystem allowlist.

## Phase kinds

Every phase defines exactly one execution kind.

Primitive phase:

```json
{
  "id": "check",
  "steps": [
    {"id":"read","primitive":"fs.read","op":"one","args":{"path":"..."}}
  ],
  "output_ref": "read"
}
```

Session phase:

```json
{
  "id": "capture_chatgpt",
  "session": {
    "binding_id": "session_...",
    "op": "capture_latest"
  },
  "advance_when": {"path":"changed","truthy":true}
}
```

Supported session operations are `identify`, `probe`, `capture_latest`, and `send`. `probe` is especially useful for low-interruption endpoints such as WeChat because it can observe change without consuming the message.

## Carry

Carry supports whole values and nested paths:

```text
{{loop.lastOutput}}
{{loop.lastOutput.reply}}
{{loop.phase.capture_antigravity}}
{{loop.phase.capture_antigravity.reply}}
```

An exact placeholder preserves the underlying value; embedded placeholders stringify it.

## Waiting and advancement

`wait_for_change` keeps a phase in place if its output hash has not changed.

`advance_when` can test a path with `equals` or `truthy`. Session capture phases normally use:

```json
{"path":"changed","truthy":true}
```

so a model that is still generating, or whose latest assistant message has not changed, does not advance the relay.

## ChatGPT ↔ Antigravity

A durable relay is now directly expressible:

```text
capture_chatgpt
  capture_latest / changed=true
       |
       v
send_antigravity
  text={{loop.lastOutput.reply}}
       |
       v
capture_antigravity
  capture_latest / changed=true
       |
       v
send_chatgpt
  text={{loop.lastOutput.reply}}
       |
       +---- next cycle ---->
```

The Session Adapter owns exact conversation fingerprints, assistant-message capture, send receipts and interrupted-send safety. The Loop Controller owns turn order, carry state, cycle bounds and wake-up.

## Crash behavior

Loop state survives the MCP request and computer-mcp restart.

Session sends use a durable `pendingSend` record before the external side effect. If the Runtime stops after a send may have occurred but before its receipt is committed, the next loop execution freezes for review rather than blindly replaying the turn.

## Control

No new top-level MCP tool is required:

```text
skill_run("runtime.loop", {op:"create", ...})
skill_run("runtime.loop", {op:"status", loop_id:"..."})
skill_run("runtime.loop", {op:"cancel", loop_id:"..."})
skill_run("runtime.loop", {op:"delete", loop_id:"..."})
```

Use `max_cycles`, `end_at`, explicit cancel and/or phase advancement conditions to bound recurring external interaction.

## Verification

- `npm run verify:loop` verifies Primitive-phase carry/change semantics.
- `npm run verify:session-adapters` verifies a real four-phase ChatGPT → Antigravity → ChatGPT browser relay, session fingerprints, duplicate receipts and interrupted-send freeze behavior.
