# AgentOS Runtime Identity

Status: **v0.9.9 foundation**

The formal product name remains **AgentOS Runtime**.

v0.9.9 adds a configurable Runtime identity so users can address the connected Runtime with a short wake name in any chat that has the computer-mcp tools connected.

Defaults:

```text
productName = AgentOS Runtime
wakeName    = AgentOS
```

Configuration:

```env
AGENTOS_NAME=AgentOS Runtime
AGENTOS_WAKE_NAME=Jarvis
AGENTOS_ALIASES=AgentOS,OWL,Jarvis
```

The wake name and aliases are exposed through:

- MCP tool metadata
- `get_capabilities`
- Capability Manifest
- `runtime.identity`

For example, after setting `AGENTOS_WAKE_NAME=Jarvis`, a connected chat can interpret:

```text
Jarvis，检查 world2_v3 的 CI。
```

as an instruction to use AgentOS Runtime tools when relevant.

## Boundary

A wake name is an invocation convention, not a magical global daemon hook. The target ChatGPT conversation must have computer-mcp connected/available. A chat with no access to the Runtime cannot activate the local machine merely by seeing the word “Jarvis”.

The identity layer lives above the Skill/Primitive stack and does not modify L1 ISA semantics.

## Verification

`npm run verify:identity` verifies the default identity and a configured `Jarvis` wake name plus aliases.
