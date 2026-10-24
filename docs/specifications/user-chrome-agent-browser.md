# OWL User Chrome Agent Browser — Default Native Messaging

For user Chrome work, call `browser_agent_open` and the other `browser_agent_*` tools. These target OWL-owned **background tabs in the user's already-signed-in Chrome**.

The Desktop Host now connects through the explicitly installed **OWL LAB Agent Browser Chrome extension + Native Messaging**. This is not OWL's headless Chromium and **does not require enabling Chrome's remote-debugging switch or TCP/9222**. Chrome Companion's 16-character pairing flow is not required.

## One-time Chrome setup

The user installs the `chrome-agent-native` extension, reviews Chrome's permissions (site access, Native Messaging and tab-specific debugger screenshots), registers its exact ID with the local OWL native host installer, and reloads the extension. An enabled OWL Connection Host is required. See `owl-desktop/docs/operations/CHROME_NATIVE_MESSAGING.md`.

## Agent flow

1. `browser_agent_status` checks connected extension/Host status. If unavailable, report this, rather than falling back to a separate headless browser without consent.
2. `browser_agent_open({url})` creates one background tab in the existing Chrome profile; saved Chrome logins are reused without extracting cookies.
3. `browser_agent_tabs` and `browser_agent_use_tab({page_id})` operate only on tabs created for the current stable OWL Session; user and other Agent tabs remain isolated.
4. `browser_agent_snapshot` returns current page text and controls; `browser_agent_fill({uid,value})` fills nonsensitive text fields; `browser_agent_click({uid})` automatically navigates safe same-origin links only. Ambiguous submissions, account changes and destructive/payment actions stay manual in this pilot.
5. `browser_agent_screenshot` uses a brief Chrome extension debugger attachment for the Agent's own tab, never a global remote-debugging server.
6. If the page needs login/CAPTCHA/2FA, `browser_agent_focus_login` brings the Agent's own tab to the front for the human. The Agent resumes the same tab afterward.
7. `browser_agent_close_tab({page_id})` closes only an Agent-owned tab.

The optional `browser_open` continues to use the isolated Playwright profile with separate login state. `OWL_CHROME_BACKEND=devtools` is an explicit developer fallback if Chrome DevTools MCP is intentionally desired.

The Chrome extension requests broad host/debugger permissions at installation. This is a meaningful trust decision. Users may revoke access from Chrome settings. It does not eliminate the user's need to review security-sensitive actions. Changes must be validated on a real installed Chrome profile before calling this a finished production workflow.
