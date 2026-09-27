# Browser Agent Adapters

AgentOS can bind durable browser conversations such as ChatGPT, Antigravity, and generic browser-based agent endpoints.

The stable contract lives in [Session Adapter Contract](../specifications/session-adapter.md).

A binding stores:

- exact expected conversation URL/fingerprint
- selectors and generation/busy markers
- last capture/reply digest
- last sent digest/text
- pending-send state
- durable send receipt
- turn counter

Persistent Loop can use session phases for `identify`, `probe`, `capture_latest`, and `send`.

A session adapter must not silently switch to a different conversation when the expected bound session disappears.

External sends use pending-send/receipt semantics so a crash after a possible send does not automatically cause duplicate replay.
