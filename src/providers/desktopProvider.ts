import { runtimeStatePath } from "../runtime/runtimePaths.js";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { envFlag } from "../security/capabilities.js";
import { assertAllowedTargetPath } from "../security/pathGuard.js";
import type { ComputerProvider, ProviderStatus } from "./types.js";

export type DesktopUiElement = {
  index: number;
  role: string;
  name: string;
  description: string;
  value: string;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
};

function requireDesktopEnabled(): void {
  if (!envFlag("ALLOW_GUI", false)) {
    throw new Error(
      "Desktop provider is disabled. Set ALLOW_GUI=true and restart computer-mcp.",
    );
  }
  if (process.platform !== "darwin") {
    throw new Error("Desktop provider currently supports macOS only.");
  }
}

function helperAppPath(): string {
  return (
    process.env.COMPUTER_MCP_HELPER_APP?.trim() ||
    path.join(os.homedir(), "Applications", "Computer MCP Helper.app")
  );
}

function helperSocketPath(): string {
  return (
    process.env.COMPUTER_MCP_HELPER_SOCKET?.trim() ||
    runtimeStatePath("helper.sock")
  );
}

function helperMode(): "auto" | "required" | "disabled" {
  const value = (process.env.MACOS_HELPER_MODE ?? "auto").trim().toLowerCase();
  if (value === "required" || value === "disabled") return value;
  return "auto";
}

async function helperInstalled(): Promise<boolean> {
  try {
    await fs.access(
      path.join(helperAppPath(), "Contents", "MacOS", "ComputerMCPHelper"),
    );
    return true;
  } catch {
    return false;
  }
}

async function socketExists(): Promise<boolean> {
  try {
    const stat = await fs.stat(helperSocketPath());
    return stat.isSocket();
  } catch {
    return false;
  }
}

async function run(command: string, args: string[]) {
  return await new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ stdout, stderr, exitCode: code ?? 1 }),
    );
  });
}


async function runWithInput(command: string, args: string[], input: string) {
  return await new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ stdout, stderr, exitCode: code ?? 1 }),
    );
    child.stdin.end(input);
  });
}

async function launchHelper(): Promise<void> {
  if (!(await helperInstalled())) {
    throw new Error(
      `Computer MCP Helper is not installed at ${helperAppPath()}. Run scripts/install-macos-helper.sh.`,
    );
  }

  await fs.mkdir(path.dirname(helperSocketPath()), {
    recursive: true,
    mode: 0o700,
  });

  const result = await run("/usr/bin/open", [
    "-gj",
    helperAppPath(),
    "--args",
    "--serve",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || "Could not launch Computer MCP Helper.",
    );
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (await socketExists()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Computer MCP Helper did not create its Unix socket.");
}

async function sendHelperRequestOnce(
  action: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<any> {
  const socketPath = helperSocketPath();

  return await new Promise<any>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = "";
    let settled = false;

    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    const timer = setTimeout(() => {
      finishError(
        new Error(`Computer MCP Helper timed out during ${action}.`),
      );
    }, timeoutMs);

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(JSON.stringify({ action, args }) + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;

      clearTimeout(timer);
      if (settled) return;
      settled = true;
      socket.end();

      try {
        const payload = JSON.parse(buffer.slice(0, newline));
        if (!payload?.ok) {
          reject(
            new Error(
              payload?.error ||
                `Computer MCP Helper failed during ${action}.`,
            ),
          );
          return;
        }
        resolve(payload.result);
      } catch (error) {
        reject(
          error instanceof Error
            ? error
            : new Error("Could not parse Computer MCP Helper response."),
        );
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      finishError(error);
    });
  });
}

async function helperRequest(
  action: string,
  args: Record<string, unknown> = {},
  options?: { autoLaunch?: boolean; timeoutMs?: number },
): Promise<any> {
  requireDesktopEnabled();
  if (helperMode() === "disabled") {
    throw new Error("Computer MCP Helper is disabled by MACOS_HELPER_MODE.");
  }

  const autoLaunch = options?.autoLaunch !== false;
  const timeoutMs = options?.timeoutMs ?? 15_000;

  if (!(await socketExists())) {
    if (!autoLaunch) {
      throw new Error("Computer MCP Helper is not running.");
    }
    await launchHelper();
  }

  try {
    return await sendHelperRequestOnce(action, args, timeoutMs);
  } catch (error) {
    if (!autoLaunch) throw error;

    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as NodeJS.ErrnoException).code ?? "")
        : "";
    const message = error instanceof Error ? error.message : String(error);
    const transportFailure =
      ["ECONNREFUSED", "ENOENT", "ECONNRESET", "EPIPE"].includes(code) ||
      message.includes("timed out during");

    if (!transportFailure) throw error;

    // A crashed helper can leave a stale Unix socket behind.
    await fs.rm(helperSocketPath(), { force: true }).catch(() => undefined);
    await launchHelper();
    return await sendHelperRequestOnce(action, args, timeoutMs);
  }
}

async function helperOrFallback<T>(
  action: string,
  args: Record<string, unknown>,
  fallback: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  const mode = helperMode();
  if (mode !== "disabled" && (await helperInstalled())) {
    try {
      return (await helperRequest(action, args, { timeoutMs })) as T;
    } catch (error) {
      if (mode === "required") throw error;
    }
  }
  return await fallback();
}

async function jxa(script: string) {
  const result = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "JXA osascript failed.");
  }
  return result.stdout.trim();
}

type ClipboardFlavor = {
  type: string;
  data: string;
  bytes: number;
};

type ClipboardSnapshotEntry = {
  token: string;
  text: string;
  types: string[];
  items: ClipboardFlavor[][];
  totalBytes: number;
  changeCount: number;
  createdAt: number;
  sha256: string;
  safeTextRestore: boolean;
  fullFidelityRestore: boolean;
};

const clipboardSnapshots = new Map<string, ClipboardSnapshotEntry>();
const CLIPBOARD_SNAPSHOT_TTL_MS = 10 * 60_000;
const CLIPBOARD_SNAPSHOT_LIMIT = 100;
const CLIPBOARD_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
const SAFE_TEXT_CLIPBOARD_TYPES = new Set([
  "public.utf8-plain-text",
  "public.utf16-plain-text",
  "public.text",
  "NSStringPboardType",
  "com.apple.traditional-mac-plain-text",
]);

function pruneClipboardSnapshots() {
  const cutoff = Date.now() - CLIPBOARD_SNAPSHOT_TTL_MS;
  for (const [token, entry] of clipboardSnapshots) {
    if (entry.createdAt < cutoff) clipboardSnapshots.delete(token);
  }
  while (clipboardSnapshots.size > CLIPBOARD_SNAPSHOT_LIMIT) {
    const first = clipboardSnapshots.keys().next().value as string | undefined;
    if (!first) break;
    clipboardSnapshots.delete(first);
  }
}

function appleScriptEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function osascript(script: string) {
  const result = await run("/usr/bin/osascript", ["-e", script]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "osascript failed.");
  }
  return result.stdout.trim();
}

function parseNumber(value: string): number | null {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : null;
}

function cleanField(value: string): string {
  return value.replaceAll("\\n", " ").replaceAll("\\r", " ").trim();
}

class DesktopProvider implements ComputerProvider {
  readonly id = "desktop";
  readonly label = "Desktop";

  async status(): Promise<ProviderStatus> {
    const installed =
      process.platform === "darwin" && (await helperInstalled());
    let helper: unknown = null;

    if (installed && (await socketExists())) {
      try {
        helper = await helperRequest("status", {}, {
          autoLaunch: false,
          timeoutMs: 3000,
        });
      } catch (error) {
        helper = {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return {
      id: this.id,
      label: this.label,
      enabled: envFlag("ALLOW_GUI", false),
      available: process.platform === "darwin",
      capabilities: [
        "desktop",
        "accessibility",
        "ui-tree",
        "region-screenshot",
        "clipboard",
        "clipboard-transaction",
        "native-helper",
      ],
      details: {
        platform: process.platform,
        helperMode: helperMode(),
        helperInstalled: installed,
        helperAppPath: helperAppPath(),
        helperSocketPath: helperSocketPath(),
        helper,
        note:
          "v0.9.2 prefers the standalone Computer MCP Helper.app, so Accessibility and Screen Recording permissions belong to the helper rather than the IDE/Terminal that launched computer-mcp.",
      },
    };
  }

  async helperStatus() {
    requireDesktopEnabled();
    return await helperRequest("status", {}, { timeoutMs: 3000 });
  }

  async helperRequestPermissions() {
    requireDesktopEnabled();
    return await helperRequest(
      "request_permissions",
      {},
      { timeoutMs: 60_000 },
    );
  }

  async frontmostApp() {
    requireDesktopEnabled();

    // NSWorkspace can report the foreground app without Accessibility/TCC.
    // Prefer it so helperMode=required does not depend on AX focused-app behavior.
    try {
      const raw = await jxa(
        'ObjC.import("AppKit"); var app=$.NSWorkspace.sharedWorkspace.frontmostApplication; JSON.stringify({app:ObjC.unwrap(app.localizedName),bundleIdentifier:ObjC.unwrap(app.bundleIdentifier)})',
      );
      const parsed = JSON.parse(raw) as {
        app?: string;
        bundleIdentifier?: string;
      };
      if (parsed.app) {
        return {
          app: parsed.app,
          bundleIdentifier: parsed.bundleIdentifier ?? "",
        };
      }
    } catch {
      // Fall through to the native helper / legacy compatibility path.
    }

    return await helperOrFallback(
      "frontmost_app",
      {},
      async () => {
        const name = await osascript(
          'tell application "System Events" to get name of first application process whose frontmost is true',
        );
        return { app: name };
      },
    );
  }

  async openApp(appName: string) {
    requireDesktopEnabled();
    return await helperOrFallback(
      "open_app",
      { app_name: appName },
      async () => {
        const safe = appleScriptEscape(appName);
        await osascript(`tell application "${safe}" to activate`);
        return { app: appName, activated: true };
      },
    );
  }

  async windowBounds(appName?: string) {
    requireDesktopEnabled();
    if (helperMode() !== "disabled" && (await helperInstalled())) {
      try {
        return await helperRequest("window_bounds", {
          app_name: appName,
        });
      } catch (error) {
        if (helperMode() === "required") throw error;
      }
    }
    const target =
      appName?.trim() || (await this.frontmostApp()).app;
    const safe = appleScriptEscape(target);

    const output = await osascript(`
      tell application "System Events"
        tell process "${safe}"
          if (count of windows) is 0 then return "NOT_FOUND"
          set p to position of front window
          set s to size of front window
          return (item 1 of p as text) & tab & (item 2 of p as text) & tab & (item 1 of s as text) & tab & (item 2 of s as text)
        end tell
      end tell
    `);

    if (output === "NOT_FOUND") {
      throw new Error(`No window found for application "${target}".`);
    }

    const [x, y, width, height] = output.split("\t").map(Number);
    if (![x, y, width, height].every(Number.isFinite)) {
      throw new Error(`Could not parse window bounds for "${target}".`);
    }

    return { app: target, x, y, width, height };
  }

  async uiTree(appName?: string, maxElements = 300): Promise<{
    app: string;
    elements: DesktopUiElement[];
    truncated: boolean;
  }> {
    requireDesktopEnabled();
    if (helperMode() !== "disabled" && (await helperInstalled())) {
      try {
        return await helperRequest(
          "ui_tree",
          {
            app_name: appName,
            max_elements: maxElements,
            max_depth: 16,
          },
          { timeoutMs: 30_000 },
        );
      } catch (error) {
        if (helperMode() === "required") throw error;
      }
    }
    const target =
      appName?.trim() || (await this.frontmostApp()).app;
    const safe = appleScriptEscape(target);
    const limit = Math.min(Math.max(Math.trunc(maxElements), 1), 1000);

    const output = await osascript(`
      tell application "System Events"
        tell process "${safe}"
          if (count of windows) is 0 then return ""
          set allItems to entire contents of front window
          set itemCount to count of allItems
          set maxCount to ${limit}
          if itemCount < maxCount then set maxCount to itemCount
          set outText to ""
          repeat with i from 1 to maxCount
            set e to item i of allItems
            set roleText to ""
            set nameText to ""
            set descText to ""
            set valueText to ""
            set px to "-1"
            set py to "-1"
            set sw to "-1"
            set sh to "-1"
            try
              set roleText to role of e as text
            end try
            try
              set nameText to name of e as text
            end try
            try
              set descText to description of e as text
            end try
            try
              set valueText to value of e as text
            end try
            try
              set p to position of e
              set px to item 1 of p as text
              set py to item 2 of p as text
            end try
            try
              set s to size of e
              set sw to item 1 of s as text
              set sh to item 2 of s as text
            end try
            set outText to outText & i & tab & roleText & tab & nameText & tab & descText & tab & valueText & tab & px & tab & py & tab & sw & tab & sh & linefeed
          end repeat
          return outText
        end tell
      end tell
    `);

    const elements = output
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line): DesktopUiElement | null => {
        const fields = line.split("\t");
        if (fields.length < 9) return null;
        return {
          index: Number(fields[0]) || 0,
          role: cleanField(fields[1] ?? ""),
          name: cleanField(fields[2] ?? ""),
          description: cleanField(fields[3] ?? ""),
          value: cleanField(fields[4] ?? ""),
          x: parseNumber(fields[5] ?? ""),
          y: parseNumber(fields[6] ?? ""),
          width: parseNumber(fields[7] ?? ""),
          height: parseNumber(fields[8] ?? ""),
        };
      })
      .filter((item): item is DesktopUiElement => Boolean(item));

    return {
      app: target,
      elements,
      truncated: elements.length >= limit,
    };
  }

  async uiFind(
    query: string,
    appName?: string,
    maxResults = 20,
    maxElements = 500,
  ) {
    requireDesktopEnabled();
    if (helperMode() !== "disabled" && (await helperInstalled())) {
      try {
        return await helperRequest(
          "ui_find",
          {
            query,
            app_name: appName,
            max_results: maxResults,
            max_elements: maxElements,
          },
          { timeoutMs: 30_000 },
        );
      } catch (error) {
        if (helperMode() === "required") throw error;
      }
    }
    const normalized = query.trim().toLowerCase();
    if (!normalized) throw new Error("UI query cannot be empty.");

    const tree = await this.uiTree(appName, maxElements);
    const matches = tree.elements
      .filter((element) =>
        [element.name, element.description, element.value, element.role]
          .join("\n")
          .toLowerCase()
          .includes(normalized),
      )
      .slice(0, Math.min(Math.max(Math.trunc(maxResults), 1), 100));

    return {
      app: tree.app,
      query,
      matches,
      scanned: tree.elements.length,
      truncated: tree.truncated,
    };
  }

  async clickElement(query: string, appName?: string, matchIndex = 0) {
    requireDesktopEnabled();
    const result = await this.uiFind(query, appName, matchIndex + 1, 700);
    const element = result.matches[matchIndex];
    if (!element) {
      throw new Error(
        `No accessible UI element matching "${query}" was found in ${result.app}.`,
      );
    }
    if (
      element.x == null ||
      element.y == null ||
      element.width == null ||
      element.height == null
    ) {
      throw new Error(
        `Matched UI element "${query}" has no usable screen geometry.`,
      );
    }

    const x = Math.round(element.x + Math.max(element.width, 1) / 2);
    const y = Math.round(element.y + Math.max(element.height, 1) / 2);
    await this.click(x, y);
    return { app: result.app, query, matchIndex, x, y, element };
  }

  async click(x: number, y: number) {
    requireDesktopEnabled();
    return await helperOrFallback(
      "click",
      { x: Math.round(x), y: Math.round(y) },
      async () => {
        await osascript(
          `tell application "System Events" to click at {${Math.round(x)}, ${Math.round(y)}}`,
        );
        return { x: Math.round(x), y: Math.round(y), clicked: true };
      },
    );
  }

  async clipboardInfo() {
    requireDesktopEnabled();
    const raw = await jxa(
      'ObjC.import("AppKit"); var pb=$.NSPasteboard.generalPasteboard; var its=pb.pasteboardItems.js; var types=[]; var total=0; var items=its.map(function(i){ return i.types.js.map(function(t){ var d=i.dataForType(t); var n=d ? Number(d.length) : 0; total+=n; var ty=ObjC.unwrap(t); types.push(ty); return {type:ty,bytes:n}; }); }); JSON.stringify({changeCount:Number(pb.changeCount),types:Array.from(new Set(types)),items:items,totalBytes:total})',
    );
    const parsed = JSON.parse(
      raw || '{"changeCount":0,"types":[],"items":[],"totalBytes":0}',
    ) as {
      changeCount: number;
      types: string[];
      items: Array<Array<{ type: string; bytes: number }>>;
      totalBytes: number;
    };
    const safeTextRestore =
      parsed.types.length === 0 ||
      parsed.types.every((type) => SAFE_TEXT_CLIPBOARD_TYPES.has(type));
    return {
      changeCount: parsed.changeCount,
      types: parsed.types,
      itemCount: parsed.items.length,
      totalBytes: parsed.totalBytes,
      safeTextRestore,
      fullFidelitySnapshotAvailable:
        parsed.totalBytes <= CLIPBOARD_SNAPSHOT_MAX_BYTES,
      maxSnapshotBytes: CLIPBOARD_SNAPSHOT_MAX_BYTES,
    };
  }

  async clipboardRead() {
    requireDesktopEnabled();
    const result = await run("/usr/bin/pbpaste", []);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "pbpaste failed.");
    }
    return { text: result.stdout };
  }

  async clipboardWrite(text: string) {
    requireDesktopEnabled();
    const result = await runWithInput("/usr/bin/pbcopy", [], text);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "pbcopy failed.");
    }
    return { writtenCharacters: text.length };
  }

  async clipboardSnapshot() {
    requireDesktopEnabled();
    pruneClipboardSnapshots();
    const info = await this.clipboardInfo();
    const { text } = await this.clipboardRead();
    const token =
      "clip_" +
      Date.now().toString(36) +
      "_" +
      randomUUID().replaceAll("-", "").slice(0, 12);
    const sha256 = createHash("sha256").update(text, "utf8").digest("hex");

    if (!info.fullFidelitySnapshotAvailable) {
      return {
        token: null,
        changeCount: info.changeCount,
        types: info.types,
        itemCount: info.itemCount,
        characters: text.length,
        bytes: Buffer.byteLength(text, "utf8"),
        totalClipboardBytes: info.totalBytes,
        sha256,
        safeTextRestore: info.safeTextRestore,
        fullFidelityRestore: false,
        reason:
          "Clipboard exceeds the full-fidelity snapshot size limit; automatic overwrite/restore is disabled.",
        maxSnapshotBytes: CLIPBOARD_SNAPSHOT_MAX_BYTES,
        expiresInMs: CLIPBOARD_SNAPSHOT_TTL_MS,
      };
    }

    const raw = await jxa(
      'ObjC.import("AppKit"); var pb=$.NSPasteboard.generalPasteboard; var its=pb.pasteboardItems.js; var items=its.map(function(i){ return i.types.js.map(function(t){ var d=i.dataForType(t); if(!d){return null;} return {type:ObjC.unwrap(t),data:ObjC.unwrap(d.base64EncodedStringWithOptions(0)),bytes:Number(d.length)}; }).filter(function(x){return x!==null;}); }); JSON.stringify({changeCount:Number(pb.changeCount),items:items})',
    );
    const serialized = JSON.parse(raw || '{"changeCount":0,"items":[]}') as {
      changeCount: number;
      items: ClipboardFlavor[][];
    };
    const fullSha256 = createHash("sha256")
      .update(JSON.stringify(serialized.items), "utf8")
      .digest("hex");

    clipboardSnapshots.set(token, {
      token,
      text,
      types: info.types,
      items: serialized.items,
      totalBytes: info.totalBytes,
      changeCount: serialized.changeCount,
      createdAt: Date.now(),
      sha256,
      safeTextRestore: info.safeTextRestore,
      fullFidelityRestore: true,
    });
    return {
      token,
      changeCount: serialized.changeCount,
      types: info.types,
      itemCount: serialized.items.length,
      characters: text.length,
      bytes: Buffer.byteLength(text, "utf8"),
      totalClipboardBytes: info.totalBytes,
      sha256,
      fullSha256,
      safeTextRestore: info.safeTextRestore,
      fullFidelityRestore: true,
      maxSnapshotBytes: CLIPBOARD_SNAPSHOT_MAX_BYTES,
      expiresInMs: CLIPBOARD_SNAPSHOT_TTL_MS,
    };
  }

  async clipboardRestore(token: string) {
    requireDesktopEnabled();
    pruneClipboardSnapshots();
    const entry = clipboardSnapshots.get(token);
    if (!entry) {
      throw new Error("Clipboard snapshot token is missing or expired.");
    }
    if (!entry.fullFidelityRestore) {
      throw new Error("Clipboard snapshot is not fully restorable.");
    }

    const tempPath = path.join(
      os.tmpdir(),
      "computer-mcp-clipboard-" + randomUUID() + ".json",
    );
    await fs.writeFile(
      tempPath,
      JSON.stringify({ items: entry.items }),
      { encoding: "utf8", mode: 0o600 },
    );

    try {
      const fileLiteral = JSON.stringify(tempPath);
      const script =
        'ObjC.import("AppKit"); ObjC.import("Foundation"); var file=' +
        fileLiteral +
        '; var ns=$.NSString.stringWithContentsOfFileEncodingError($(file),$.NSUTF8StringEncoding,null); var payload=JSON.parse(ObjC.unwrap(ns)); var pb=$.NSPasteboard.generalPasteboard; pb.clearContents; var arr=$.NSMutableArray.alloc.init; payload.items.forEach(function(fields){ var item=$.NSPasteboardItem.alloc.init; fields.forEach(function(f){ var data=$.NSData.alloc.initWithBase64EncodedStringOptions($(f.data),0); item.setDataForType(data,$(f.type)); }); arr.addObject(item); }); if(payload.items.length>0){pb.writeObjects(arr);} JSON.stringify({changeCount:Number(pb.changeCount),items:payload.items.length})';
      const restored = JSON.parse(await jxa(script)) as {
        changeCount: number;
        items: number;
      };
      return {
        token,
        restored: true,
        fullFidelity: true,
        itemCount: restored.items,
        changeCount: restored.changeCount,
        characters: entry.text.length,
        sha256: entry.sha256,
      };
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  async clipboardWaitChange(
    previousChangeCount: number,
    timeoutMs = 2000,
    pollMs = 50,
  ) {
    requireDesktopEnabled();
    const timeout = Math.min(Math.max(Math.trunc(timeoutMs), 100), 30_000);
    const poll = Math.min(Math.max(Math.trunc(pollMs), 20), 1000);
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
      const info = await this.clipboardInfo();
      if (info.changeCount !== previousChangeCount) {
        const { text } = await this.clipboardRead();
        return {
          changed: true,
          previousChangeCount,
          changeCount: info.changeCount,
          elapsedMs: Date.now() - startedAt,
          text,
          characters: text.length,
          types: info.types,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, poll));
    }

    const info = await this.clipboardInfo();
    return {
      changed: false,
      previousChangeCount,
      changeCount: info.changeCount,
      elapsedMs: Date.now() - startedAt,
      text: null,
      characters: 0,
      types: info.types,
    };
  }

  async clipboardCopySelection(timeoutMs = 2000, restore = true) {
    requireDesktopEnabled();
    const snapshot = await this.clipboardSnapshot();
    if (restore && !snapshot.fullFidelityRestore) {
      return {
        copied: false,
        restored: false,
        reason:
          snapshot.reason ||
          "Existing clipboard could not be snapshotted safely; copy was skipped.",
        snapshot: {
          types: snapshot.types,
          totalClipboardBytes: snapshot.totalClipboardBytes,
          fullFidelityRestore: snapshot.fullFidelityRestore,
        },
      };
    }

    await this.key("c", ["command"]);
    const changed = await this.clipboardWaitChange(
      snapshot.changeCount,
      timeoutMs,
      50,
    );

    let restored = false;
    if (changed.changed && restore) {
      await this.clipboardRestore(snapshot.token!);
      restored = true;
    }

    const copiedText =
      changed.changed &&
      typeof changed.text === "string" &&
      changed.text.length > 0;

    return {
      copied: copiedText,
      clipboardChanged: changed.changed,
      restored,
      text: copiedText ? changed.text : null,
      characters: copiedText ? changed.characters : 0,
      elapsedMs: changed.elapsedMs,
      clipboardTypes: changed.types,
      reason: !changed.changed
        ? "Clipboard did not change after Cmd+C."
        : copiedText
          ? null
          : "Clipboard changed after Cmd+C but contained no text.",
    };
  }

  async type(text: string, preserveClipboard = true) {
    requireDesktopEnabled();
    const snapshot = preserveClipboard ? await this.clipboardSnapshot() : null;
    if (snapshot && !snapshot.fullFidelityRestore) {
      throw new Error(
        "Refusing to overwrite the clipboard because a full-fidelity snapshot could not be created. Use preserve_clipboard=false only when replacing the current clipboard is acceptable.",
      );
    }

    await this.clipboardWrite(text);
    try {
      await this.key("v", ["command"]);
    } finally {
      if (snapshot) await this.clipboardRestore(snapshot.token!);
    }
    return {
      typedCharacters: text.length,
      method: "clipboard-paste",
      clipboardRestored: Boolean(snapshot),
    };
  }

  async key(
    key: string,
    modifiers: Array<"command" | "option" | "control" | "shift"> = [],
  ) {
    requireDesktopEnabled();
    if (helperMode() !== "disabled" && (await helperInstalled())) {
      try {
        return await helperRequest("key", { key, modifiers });
      } catch (error) {
        if (helperMode() === "required") throw error;
      }
    }

    const keyCodes: Record<string, number> = {
      enter: 36,
      return: 36,
      tab: 48,
      space: 49,
      escape: 53,
      left: 123,
      right: 124,
      down: 125,
      up: 126,
      delete: 51,
      backspace: 51,
      pageup: 116,
      pagedown: 121,
    };

    const modifierMap: Record<string, string> = {
      command: "command down",
      option: "option down",
      control: "control down",
      shift: "shift down",
    };

    const using = modifiers.length
      ? ` using {${modifiers.map((m) => modifierMap[m]).join(", ")}}`
      : "";

    const normalized = key.toLowerCase().replaceAll(" ", "");
    if (keyCodes[normalized] != null) {
      await osascript(
        `tell application "System Events" to key code ${keyCodes[normalized]}${using}`,
      );
    } else if (key.length === 1) {
      await osascript(
        `tell application "System Events" to keystroke "${appleScriptEscape(key)}"${using}`,
      );
    } else {
      throw new Error("Unsupported key name.");
    }

    return { key, modifiers };
  }

  async screenshot(outputPath: string) {
    requireDesktopEnabled();
    const safePath = await assertAllowedTargetPath(outputPath);
    await fs.mkdir(path.dirname(safePath), { recursive: true });
    return await helperOrFallback(
      "screenshot",
      { path: safePath },
      async () => {
        const result = await run("/usr/sbin/screencapture", ["-x", safePath]);
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || "screencapture failed.");
        }
        return { path: safePath };
      },
      30_000,
    );
  }

  async screenshotWindow(outputPath: string, appName?: string) {
    requireDesktopEnabled();
    const safePath = await assertAllowedTargetPath(outputPath);
    await fs.mkdir(path.dirname(safePath), { recursive: true });

    if (helperMode() === "disabled" || !(await helperInstalled())) {
      throw new Error(
        "Background window capture requires Computer MCP Helper. Install/update it with scripts/install-macos-helper.sh.",
      );
    }

    return await helperRequest(
      "screenshot_window",
      {
        path: safePath,
        ...(appName?.trim() ? { app_name: appName.trim() } : {}),
      },
      { timeoutMs: 30_000 },
    );
  }

  async ocrWindow(
    outputPath: string,
    appName?: string,
    languages: string[] = [],
  ) {
    requireDesktopEnabled();
    const safePath = await assertAllowedTargetPath(outputPath);
    await fs.mkdir(path.dirname(safePath), { recursive: true });

    if (helperMode() === "disabled" || !(await helperInstalled())) {
      throw new Error(
        "Background window OCR requires Computer MCP Helper. Install/update it with scripts/install-macos-helper.sh.",
      );
    }

    return await helperRequest(
      "ocr_window",
      {
        path: safePath,
        ...(appName?.trim() ? { app_name: appName.trim() } : {}),
        languages: languages.slice(0, 8),
      },
      { timeoutMs: 45_000 },
    );
  }

  async screenshotRegion(
    outputPath: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ) {
    requireDesktopEnabled();
    const values = [x, y, width, height].map((value) => Math.round(value));
    if (values.some((value) => !Number.isFinite(value)) || width <= 0 || height <= 0) {
      throw new Error("Invalid screenshot region.");
    }

    const safePath = await assertAllowedTargetPath(outputPath);
    await fs.mkdir(path.dirname(safePath), { recursive: true });
    if (helperMode() !== "disabled" && (await helperInstalled())) {
      try {
        return await helperRequest(
          "screenshot_region",
          {
            path: safePath,
            x: values[0],
            y: values[1],
            width: values[2],
            height: values[3],
          },
          { timeoutMs: 30_000 },
        );
      } catch (error) {
        if (helperMode() === "required") throw error;
      }
    }
    const region = values.join(",");
    const result = await run("/usr/sbin/screencapture", [
      "-x",
      "-R",
      region,
      safePath,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "regional screencapture failed.");
    }
    return { path: safePath, x: values[0], y: values[1], width: values[2], height: values[3] };
  }
}

export const desktopProvider = new DesktopProvider();
