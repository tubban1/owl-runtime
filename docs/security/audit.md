# Audit

AgentOS writes structured audit events when audit logging is enabled.

Audit context should preserve:

- tool/action/Primitive/Skill identity
- Runtime execution context
- MCP transport session for attribution
- durable Task/Process/Transaction owner when present
- workspace ownership
- action duration and resource wait time
- side-effect contract
- verification/failure outcome

Production audit log defaults under the production state root; development uses the development state root.

Audit data is operational evidence, not semantic memory. Promotion into M3 requires the normal explicit memory gates.
