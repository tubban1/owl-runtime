# OWL LAB Windows native GUI — source & authorization contract

Status: DEV implementation; Windows signed installer/release certification remains separate.

## Architecture

- Windows GUI is provided by `windows-helper/OWLHelper.cs`, compiled with the
  system .NET Framework 4.8 C# compiler to a local x64 `OWLHelper.exe`.
- The helper is a **single-shot child process** of OWL Runtime: one JSON line
  on stdin, one bounded JSON result on stdout. No independent MCP service,
  inbound socket, persistent credentials or direct remote connection.
- Runtime verifies `component.json` SHA-256 before each helper invocation.
  Binary+receipt are local development integrity evidence, **not a
  production code-signing certificate**.
- Normal Runtime device grant, action policy, path scope and action risk rules
  apply before the GUI child process is invoked. Do not turn on Shell/Delete as
  a side effect of GUI permission.

## Local Windows Desktop consent modes

| Mode | Window/UI tree/screenshot | UI Automation actions | SendInput physical cursor/keyboard |
| --- | --- | --- | --- |
| Off (default) | No | No | No |
| Inspect | Yes | No | No |
| Semantic | Yes | Invoke / Toggle / Select / focused ValuePattern | No |
| Foreground | Yes | Yes | Yes, if UI Automation cannot fulfill the action |

Users change mode **locally in OWL LAB Desktop Permission center** and confirm
via a native dialog. General settings updates and remote MCP commands cannot
grant this permission. The managed Runtime must actually restart with the
new policy; a saved setting is not proof of capability activation.

`ALLOW_GUI`, `OWL_WIN_GUI_INPUT`, `OWL_WIN_GUI_FOREGROUND_INPUT` and
`OWL_WIN_GUI_HELPER_PATH` are derived from the locally saved mode and
verified helper. These flags must never be blindly set to true by an agent.

## Input semantics and limitations

- UI Automation `InvokePattern`, `TogglePattern`, `SelectionItemPattern`
  and `ValuePattern.SetValue` **do not send physical cursor movement**.
  A particular application may still change focus after a UIA operation;
  a universally focus-free interaction is not guaranteed.
- `desktop.click_element` selects a semantic UIA target. It fails closed
  when no suitable pattern exists; there is no implicit center-coordinate
  mouse fallback.
- `desktop.click(x,y)` first attempts semantic invocation at the coordinate.
  Only **Foreground** mode may move the real cursor and send a physical click.
- `desktop.type(text)` sets the current focused editable value when possible
  (replacement semantics). For other controls it uses Unicode SendInput
  **only in Foreground mode**. It never silently pastes a clipboard token.
- `desktop.key` and activating an existing window require Foreground mode.
  They may affect the user's current window and must be explicitly requested.
  Open-app cannot execute arbitrary binaries; only an existing UI window
  can be activated. New app launch requires separate approved Shell.
- The helper refuses password fields and UAC/Winlogon secure desktop. It
  operates only in the user's interactive session; UIA cannot control an
  unrelated session or guarantee controlling elevated windows.
- Background browser tab automation should still use OWL Agent Browser,
  which avoids native file dialogs and is the nonintrusive default.
- Clipboard restore, individual window capture and OCR are not claimed
  as working Windows native capabilities in this revision.

## Build and checks

On Windows, in an exact pinned Runtime checkout:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/build-gui-helper.ps1
```

It generates `windows-helper/bin/OWLHelper.exe` and `component.json`.
These are ignored by Git; do not commit binary files.

Run helper status and negative-permission checks through the dedicated
`scripts/windows/verify-gui-helper.ps1`, which does not send real pointer
or keyboard input to user applications.

Before distribution to external users: build a signed Windows Helper,
complete installer/startup/upgrade/rollback tests, verify actual login
session behavior and Cloud/ChatGPT MCP tool discovery, and retest on a
clean Windows account. Source or developer-only runtime acceptance is NOT
proof of deployable, signed Windows production support.
