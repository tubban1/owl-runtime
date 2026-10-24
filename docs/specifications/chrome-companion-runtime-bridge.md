# Chrome Companion tools on OWL Runtime MCP

OWL Runtime and OWL Desktop expose separate MCP catalogs. The Chrome Companion tools are implemented in Desktop's local MCP server, and were previously invisible to ChatGPT connections using the Runtime MCP. The optional Runtime bridge now registers the seven `browser_companion_*` tools and forwards **only these names** to Desktop MCP on local loopback.

## Prerequisites

- Run an updated OWL Desktop Connection Host with local MCP listening on `127.0.0.1:8790/mcp` and the Chrome Companion broker on `127.0.0.1:8794`.
- Run an updated OWL Runtime MCP build; Runtime's tool catalog changes require restarting its MCP service and refreshing the ChatGPT connection. Restarting the Desktop Host alone does not update Runtime tools.
- Install the unpacked Chrome Companion extension in Chrome and explicitly authorize the chosen website/tab in its popup.
- No Chrome cookies are copied to Runtime. Consent and user confirmation remain owned by Chrome Companion. Browser text/screenshots returned through this bridge enter the invoking ChatGPT conversation.

## Configuration

- `OWL_DESKTOP_MCP_URL` defaults to `http://127.0.0.1:8790/mcp`; only plain HTTP on numeric IPv4 loopback `127.0.0.1` with `/mcp` path is permitted. DNS aliases, public tunnels, LAN hosts, embedded credentials and arbitrary URLs fail closed.
- If Desktop MCP requires a bearer token, supply it to Runtime as `OWL_DESKTOP_MCP_TOKEN` through a protected runtime environment; do not include it in prompts.
- `OWL_COMPANION_BRIDGE_DISABLED=true` disables all bridge calls.
- The Runtime MCP transport session ID is passed as a stable owner routing value to the Desktop MCP; other Runtime transport sessions cannot automatically inherit a pairing. If ChatGPT/Tunnel reconnect changes its transport session, a new pairing may be needed.
- The bridge is not registered on the Cloud gateway's separately curated tool list. A Cloud gateway client can use existing `owl_devices` then `owl_call` with `toolName: browser_companion_pair` and the selected device ID.

## User flow

1. From ChatGPT connected to the updated **OWL Runtime MCP** call `browser_companion_pair` and receive a short-lived code.
2. Enter it in Chrome Companion; pair and explicitly authorize the selected tab (two-minute grant).
3. Call `browser_companion_status`, then `browser_companion_snapshot`.
4. For editing, explicitly enable form filling in Chrome Companion before `browser_companion_fill`.
5. `browser_companion_click` returns a pending request ID; a person must confirm in the popup. Call `browser_companion_action_result` and then verify the actual saved content.
6. For independent screenshot evidence, the person must start Chrome's authorized tab capture before `browser_companion_screenshot`.

Use `npx tsx scripts/verify-chrome-companion-mcp-bridge.ts` for owner/allowlist/SSRF guard regression, and an isolated MCP server + local Desktop MCP for a real tool-list/status E2E check.
