# OWL Agent Browser — default, no pairing

For website UI work, OWL LAB should prefer `browser_agent_open` (or the existing managed `browser_open`) before considering Chrome Companion. This directly uses the Runtime's own persistent Chromium profile. **There is no Chrome Companion pairing code, extension installation, per-site permission prompt or per-tab authorization** for Agent-created tabs in this profile.

## Intended workflow

1. The Agent calls `browser_agent_open({url:"https://www.reddit.com"})`. Runtime creates a background tab for the invoking Session. Its tab ID is a locator, not a permission token.
2. The Agent uses `browser_snapshot`, `browser_click`, `browser_type`, `browser_screenshot` and `browser_list_tabs` / `browser_use_tab` to navigate, inspect and complete routine work. Every new tab created by a Session stays owned by that Session, even after another tab is opened; foreign or human pages cannot be selected or closed by it.
3. Authentication is saved in the dedicated OWL-managed Chrome user-data directory. If the Agent encounters a login, passkey, 2FA or CAPTCHA, it asks the user to sign in **in that OWL browser window**, then continues on its tab when the login completes. Never collect credentials through the agent chat or copy cookies from the user's personal Chrome profile.
4. Browser automation does not automatically grant the Agent arbitrary OS/filesystem access or permission to make unrequested transactions. Runtime audit, policy and approval checks continue to apply to consequential operations.
5. Browser launch may show an OWL Chrome window initially; after startup the Agent uses Chromium background targets and independent screenshots without switching the user's active personal Chrome tab.

## Scope

- Agent-managed Chrome profile is distinct from regular Google Chrome. Existing Reddit login in regular Chrome will not automatically be present in OWL Browser. The user may have to log in once on this profile.
- The old Chrome Companion workflow is **optional** only if the user explicitly needs their already-signed-in personal Chrome profile. Companion still requires separate consent, for a different security boundary.
- A runtime/transport restart may require the new Session to open/select its own tab again; the persistent Chrome profile still retains login state. Transferring control of an existing live tab to another Session requires an explicit handoff.

## Verification

Run `npx tsx scripts/verify-browser-owner-tabs.ts`. This uses a disposable Chromium profile, verifies direct open without pairing, two tabs owned by one Session, another Session cannot select either, independent snapshots/screenshots, and no global browser close.
