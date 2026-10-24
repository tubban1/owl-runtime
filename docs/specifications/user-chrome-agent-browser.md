# OWL User Chrome (default Agent Browser)

The default browser backend is the user's **already running normal Chrome**, not an isolated headless Chromium profile. It uses Google's official Chrome DevTools MCP `--autoConnect` API with one long-lived MCP child process per OWL Connection Host. It does not use Chrome Companion pairing, site-by-site permissions, or user-data-dir copies.

## First connection

1. Chrome **144 or newer** must be running on the host. In the user's own Chrome, visit `chrome://inspect/#remote-debugging` and enable Chrome's remote debugging feature.
2. Call `browser_agent_open({url:"https://www.reddit.com/settings/profile"})`. Chrome prompts the user to approve a debugging connection. The user clicks **Allow**. **This is mandatory browser security consent**, not a per-page authorization.
3. The Host retains its Chrome DevTools MCP connection across ChatGPT Agent Sessions. Additional OWL Sessions do not reconnect to Chrome or require new pairing codes. A Host restart or Chrome disconnect may trigger another Chrome permission dialog.
4. OWL opens its tabs with `new_page({url,background:true})` in the **existing Chrome profile**, reusing existing login cookies and extensions naturally within Chrome, with no cookie export.
5. Agent uses `browser_agent_snapshot`, `browser_agent_fill({uid,value})`, `browser_agent_click({uid})`, `browser_agent_screenshot`, `browser_agent_tabs`, `browser_agent_use_tab({page_id})`, and `browser_agent_close_tab({page_id})`. UIDs must come from a fresh accessibility snapshot. Each Session sees and controls only its own new tabs; no human tab IDs or other Session tabs are disclosed.
6. When Reddit asks for human verification, call `browser_agent_focus_login`. Only **that Agent-owned tab** comes forward. The user completes login/CAPTCHA/2FA in Chrome and says to continue; the Agent uses the same pageId afterward. No need to close other Agents' tabs or change any global headless setting.

`browser_open` remains **opt-in isolated Chromium** only, for separate profiles, headless tasks, or test isolation. Do not automatically fall back to it on a Chrome native connection error, because that breaks login reuse.

## Security and tradeoffs

- Chrome's official remote-debugging permission is more powerful than an individual extension host grant. Chrome displays an automation banner while connected. The OWL bridge restricts exposed commands to Agent-created tab IDs; this is not equivalent to sandboxing the underlying privileged MCP child process. Only connect a trusted local OWL installation, and disable Chrome remote debugging when not wanted.
- Chrome DevTools MCP currently needs a consent prompt on each **connection**, not on each **tab**. OWL avoids per-Agent prompts by maintaining one long-lived child process. The user can deny the dialog to prevent access.
- Passwords, one-time codes, CVV and token-like controls are blocked from Agent fill. Destructive/account-security/purchase operations are not automatically clicked; Runtime and user intent remain the authority for consequences.
- This mode intentionally reuses the selected Chrome profile's existing authentication and may face fewer login barriers than headless automation; it **does not** bypass CAPTCHA or guarantee that Reddit never challenges the user.
- MCP Browser result snapshots and images sent to the invoking ChatGPT session may traverse OWL Cloud/Tunnel and should be treated as session data.
- Chrome DevTools MCP installed via pinned `chrome-devtools-mcp@1.11.0 --autoConnect`. Optional `OWL_CHROME_DEVTOOLS_MCP_CLI` can point to a preinstalled local CLI entrypoint (without downloading code at runtime).
- The Chrome DevTools native bridge does not require the Chrome Companion extension. The older Companion remains available as an alternative with narrower per-site permission, if the user prefers not enabling whole-browser debugging.

## Verification

Unit tests use a fake persistent Chrome DevTools MCP connection to prove `new_page.background===true`, shared connection across Sessions, strict page ownership, human tab not exposed, non-credential fill, background screenshot, and explicit focus-for-login. Real existing-profile E2E requires the user's Chrome remote-debugging toggle and one user-approved Chrome consent; do not claim this acceptance until it has actually happened.
