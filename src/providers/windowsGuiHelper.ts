import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envFlag } from "../security/capabilities.js";

// Windows GUI actions are always local Runtime-owned, explicitly opt-in,
// non-retrying helper calls. There is no second MCP server, freeform command,
// local network listener or background consent bypass.
const readActions = new Set([
  "status", "frontmost_app", "window_bounds", "ui_tree",
  "screenshot", "screenshot_region",
]);
const inputActions = new Set([
  "click", "click_element", "type", "key", "open_app",
  "clipboard_read", "clipboard_info", "clipboard_write",
]);
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024;

function helperPath() {
  const configured = process.env.OWL_WIN_GUI_HELPER_PATH?.trim();
  if (configured && path.isAbsolute(configured)) return configured;
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../windows-helper/bin/OWLHelper.exe",
  );
}

export function windowsGuiModeStatus() {
  const enabled = process.platform === "win32" && envFlag("ALLOW_GUI");
  const semanticInput = enabled && envFlag("OWL_WIN_GUI_INPUT");
  const foregroundInput = semanticInput && envFlag("OWL_WIN_GUI_FOREGROUND_INPUT");
  const executable = helperPath();
  let helperInstalled = false;
  let componentVerified = false;
  let reason: string | null = null;
  try {
    if (!fs.existsSync(executable) || fs.lstatSync(executable).isSymbolicLink() ||
        !fs.statSync(executable).isFile()) {
      reason = "WINDOWS_GUI_HELPER_NOT_INSTALLED";
    } else {
      helperInstalled = true;
      const manifestPath = path.join(path.dirname(executable), "component.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
      const sha = createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
      componentVerified =
        manifest?.component === "owl-windows-gui-helper" &&
        manifest?.architecture === "win32-x64" &&
        manifest?.sha256 === sha;
      if (!componentVerified) reason = "WINDOWS_GUI_HELPER_INTEGRITY_FAILED";
    }
  } catch {
    reason = "WINDOWS_GUI_HELPER_INTEGRITY_FAILED";
  }
  return {
    platform: process.platform,
    helperMode: "windows-native-ui-automation",
    helperInstalled,
    componentVerified,
    available: process.platform === "win32" && componentVerified,
    enabled: enabled && componentVerified,
    semanticInput: semanticInput && componentVerified,
    foregroundInput: foregroundInput && componentVerified,
    readOnly: !semanticInput,
    reason,
  };
}

export async function windowsGuiAction(
  action: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  if (process.platform !== "win32") throw Error("WINDOWS_GUI_PLATFORM_REQUIRED");
  if (!envFlag("ALLOW_GUI")) throw Error("WINDOWS_GUI_READ_NOT_AUTHORIZED");
  if (!readActions.has(action) && !inputActions.has(action))
    throw Error("WINDOWS_GUI_ACTION_UNSUPPORTED");
  if (inputActions.has(action) && !envFlag("OWL_WIN_GUI_INPUT"))
    throw Error("WINDOWS_GUI_INPUT_NOT_AUTHORIZED");
  if (["key", "open_app"].includes(action) && !envFlag("OWL_WIN_GUI_FOREGROUND_INPUT"))
    throw Error("WINDOWS_GUI_FOREGROUND_TAKEOVER_REQUIRED");
  const capability = windowsGuiModeStatus();
  if (!capability.componentVerified) throw Error(capability.reason ??
    "WINDOWS_GUI_HELPER_INTEGRITY_FAILED");

  const json = JSON.stringify({ action, ...args });
  if (Buffer.byteLength(json) > MAX_REQUEST_BYTES) throw Error("WINDOWS_GUI_REQUEST_TOO_LARGE");
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const child = spawn(helperPath(), ["--request-stdin"], {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
        WINDIR: process.env.WINDIR ?? "C:\\Windows",
        TEMP: process.env.TEMP ?? "",
        TMP: process.env.TMP ?? "",
        USERPROFILE: process.env.USERPROFILE ?? "",
        OWL_WIN_GUI_READ_GRANTED: "true",
        OWL_WIN_GUI_INPUT_GRANTED: envFlag("OWL_WIN_GUI_INPUT") ? "true" : "false",
        OWL_WIN_GUI_FOREGROUND_GRANTED:
          envFlag("OWL_WIN_GUI_FOREGROUND_INPUT") ? "true" : "false",
      },
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      finish(Error("WINDOWS_GUI_HELPER_TIMEOUT_UNCERTAIN_RESULT"));
    }, 15_000);
    timer.unref?.();
    child.on("error", () => finish(Error("WINDOWS_GUI_HELPER_LAUNCH_FAILED")));
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(Error("WINDOWS_GUI_HELPER_OUTPUT_TOO_LARGE"));
      }
    });
    child.once("close", () => {
      if (settled) return;
      try {
        const response = JSON.parse(output.trim());
        if (response?.ok === true) {
          finish(undefined, response.result);
        } else {
          // Only helper-defined machine error codes cross the boundary.
          const code = typeof response?.code === "string" &&
            /^WINDOWS_[A-Z0-9_]{1,90}$/.test(response.code)
            ? response.code : "WINDOWS_GUI_HELPER_FAILED";
          finish(Error(code));
        }
      } catch {
        finish(Error("WINDOWS_GUI_HELPER_INVALID_RESPONSE"));
      }
    });
    child.stdin.on("error", () => { /* close/error owns completion */ });
    child.stdin.end(json + "\n");
  });
}
