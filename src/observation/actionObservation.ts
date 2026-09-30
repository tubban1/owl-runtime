import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { browserProvider } from "../providers/browserProvider.js";
import { desktopProvider } from "../providers/desktopProvider.js";
import { getFileInfo } from "../tools/fileOps.js";
import {
  createObservation,
  type Observation,
  type ObservationEvidence,
} from "./observationAbi.js";
import {
  uncertainVerificationReceipt,
  verifyObservation,
  type VerificationExpectation,
  type VerificationReceipt,
  type VerificationSpec,
} from "../verification/verifier.js";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function stringField(value: unknown, key: string): string | undefined {
  const object = asObject(value);
  const field = object?.[key];
  return typeof field === "string" && field ? field : undefined;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function evidenceForResult(
  result: unknown,
  fallbackKind: ObservationEvidence["kind"] = "structured",
): ObservationEvidence[] {
  const object = asObject(result);
  const evidence: ObservationEvidence[] = [];

  const path = stringField(result, "path");
  const text = stringField(result, "text");
  if (path && /\.(png|jpe?g|webp)$/i.test(path)) {
    evidence.push({ kind: "screenshot", ref: path });
  }
  if (text) {
    evidence.push({ kind: "text", summary: text.slice(0, 500) });
  }
  if (object || Array.isArray(result)) {
    evidence.push({ kind: fallbackKind });
  }
  return evidence;
}

async function observeFileMutation(
  action: string,
  args: JsonObject,
  result: unknown,
): Promise<Observation | null> {
  if (action === "fs.delete") {
    const target = stringField(result, "path") ?? stringField(args, "path");
    if (!target) return null;
    try {
      const info = await getFileInfo(target);
      return createObservation({
        channel: "file",
        provider: "filesystem",
        subject: target,
        data: { exists: true, ...info },
        evidence: [{ kind: "file_metadata" }],
      });
    } catch (error) {
      const missing =
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
        (error instanceof Error && error.message === "Path does not exist.");
      if (!missing) throw error;
      return createObservation({
        channel: "file",
        provider: "filesystem",
        subject: target,
        data: { path: target, exists: false },
        evidence: [{ kind: "file_metadata", metadata: { exists: false } }],
      });
    }
  }

  const target =
    stringField(result, "path") ??
    stringField(result, "destination") ??
    stringField(args, "path") ??
    stringField(args, "destination_path");
  if (!target) return null;

  const info = await getFileInfo(target);
  return createObservation({
    channel: "file",
    provider: "filesystem",
    subject: target,
    data: { exists: true, ...info },
    evidence: [{ kind: "file_metadata", metadata: { size: info.size, type: info.type } }],
  });
}

async function observeBatchEdit(args: JsonObject): Promise<Observation | null> {
  const edits = Array.isArray(args.edits) ? args.edits : [];
  const files: JsonObject[] = [];
  for (const edit of edits) {
    const path =
      edit && typeof edit === "object"
        ? (edit as JsonObject).path
        : undefined;
    if (typeof path !== "string") continue;
    const info = await getFileInfo(path);
    files.push({ exists: true, ...info });
  }
  return createObservation({
    channel: "file",
    provider: "filesystem",
    state: "ready",
    data: { files },
    evidence: [{ kind: "file_metadata", metadata: { count: files.length } }],
  });
}

async function observeBrowserAfterMutation(
  action: string,
  args: JsonObject,
): Promise<Observation> {
  try {
    const snapshot = await browserProvider.snapshot(30_000);
    const selector = stringField(args, "selector");
    const target =
      selector && ["browser.type", "browser.upload"].includes(action)
        ? await browserProvider.controlState(selector)
        : undefined;

    return createObservation({
      channel: "web",
      provider: "browser",
      subject: snapshot.url,
      state: "ready",
      data: {
        ...snapshot,
        ...(target ? { target } : {}),
      },
      evidence: [
        { kind: "text", summary: snapshot.text.slice(0, 500) },
        {
          kind: "structured",
          metadata: {
            controls: snapshot.controls.length,
            links: snapshot.links.length,
            ...(target
              ? {
                  targetExists: target.exists,
                  targetCount: target.count,
                }
              : {}),
          },
        },
      ],
    });
  } catch (error) {
    return createObservation({
      channel: "web",
      provider: "browser",
      state: "unknown",
      data: {
        action,
        observationError:
          error instanceof Error ? error.message : String(error),
      },
      evidence: [
        {
          kind: "system",
          summary:
            "The browser action returned, but post-action observation failed; side effects must be treated as uncertain.",
        },
      ],
    });
  }
}

async function observeDesktopAfterMutation(
  action: string,
): Promise<Observation> {
  try {
    if (action === "desktop.clipboard_write") {
      const clipboard = await desktopProvider.clipboardRead();
      const text =
        clipboard &&
        typeof clipboard === "object" &&
        typeof (clipboard as JsonObject).text === "string"
          ? ((clipboard as JsonObject).text as string)
          : "";
      return createObservation({
        channel: "ui",
        provider: "desktop",
        state: "ready",
        data: {
          clipboard: {
            characters: text.length,
            sha256: sha256Text(text),
          },
        },
        evidence: [
          {
            kind: "structured",
            metadata: {
              clipboardCharacters: text.length,
            },
          },
        ],
      });
    }

    const frontmost = await desktopProvider.frontmostApp();
    return createObservation({
      channel: "ui",
      provider: "desktop",
      subject: stringField(frontmost, "app"),
      state: "ready",
      data: {
        action,
        frontmost,
      },
      evidence: [{ kind: "system" }],
    });
  } catch (error) {
    return createObservation({
      channel: "ui",
      provider: "desktop",
      state: "unknown",
      data: {
        action,
        observationError:
          error instanceof Error ? error.message : String(error),
      },
      evidence: [
        {
          kind: "system",
          summary:
            "The desktop action returned, but deterministic post-action observation was unavailable; side effects must be treated as uncertain.",
        },
      ],
    });
  }
}

export async function observeRoutedActionOutcome(
  action: string,
  args: JsonObject,
  result: unknown,
): Promise<Observation | null> {
  if (
    [
      "fs.mkdir",
      "fs.write",
      "fs.append",
      "fs.edit",
      "fs.move",
      "fs.copy",
      "fs.delete",
    ].includes(action)
  ) {
    return await observeFileMutation(action, args, result);
  }
  if (action === "fs.batch_edit") return await observeBatchEdit(args);

  if (action === "fs.read") {
    const path = stringField(args, "path");
    return createObservation({
      channel: "file",
      provider: "filesystem",
      ...(path ? { subject: path } : {}),
      data: { path: path ?? null, content: result },
      evidence: [{ kind: "file_content", ...(path ? { ref: path } : {}) }],
    });
  }
  if (
    ["fs.read_many", "fs.list", "fs.tree", "fs.info", "fs.search"].includes(action)
  ) {
    const subject =
      stringField(args, "path") ??
      stringField(args, "root_path");
    return createObservation({
      channel: "file",
      provider: "filesystem",
      ...(subject ? { subject } : {}),
      data: result,
      evidence: evidenceForResult(result, "structured"),
    });
  }

  if (["browser.click", "browser.type", "browser.upload"].includes(action)) {
    return await observeBrowserAfterMutation(action, args);
  }
  if (
    [
      "browser.open",
      "browser.tabs",
      "browser.use_tab",
      "browser.new_tab",
      "browser.snapshot",
      "browser.find",
    ].includes(action)
  ) {
    const subject = stringField(result, "url");
    return createObservation({
      channel: "web",
      provider: "browser",
      ...(subject ? { subject } : {}),
      state: "ready",
      data: result,
      evidence: evidenceForResult(
        result,
        action === "browser.snapshot" ? "text" : "structured",
      ),
    });
  }
  if (action === "browser.screenshot") {
    return createObservation({
      channel: "web",
      provider: "browser",
      subject: stringField(result, "url"),
      data: result,
      evidence: evidenceForResult(result, "screenshot"),
    });
  }

  if (action === "desktop.helper_status") {
    return createObservation({
      channel: "environment",
      provider: "desktop",
      state: "ready",
      data: result,
      evidence: [{ kind: "system" }],
    });
  }
  if (
    [
      "desktop.click",
      "desktop.type",
      "desktop.key",
      "desktop.click_element",
      "desktop.clipboard_write",
    ].includes(action)
  ) {
    return await observeDesktopAfterMutation(action);
  }

  if (action === "desktop.open_app") {
    const frontmost = await desktopProvider.frontmostApp();
    return createObservation({
      channel: "ui",
      provider: "desktop",
      subject: stringField(frontmost, "app"),
      state: "ready",
      data: frontmost,
      evidence: [{ kind: "system" }],
    });
  }
  if (
    [
      "desktop.frontmost_app",
      "desktop.window_bounds",
      "desktop.ui_tree",
      "desktop.ui_find",
      "desktop.clipboard_read",
      "desktop.clipboard_info",
      "desktop.clipboard_snapshot",
      "desktop.clipboard_wait_change",
    ].includes(action)
  ) {
    return createObservation({
      channel: "ui",
      provider: "desktop",
      subject:
        stringField(result, "app") ??
        stringField(args, "app_name"),
      state: "ready",
      data: result,
      evidence: evidenceForResult(
        result,
        action.startsWith("desktop.ui_") ? "accessibility" : "structured",
      ),
    });
  }
  if (
    [
      "desktop.screenshot",
      "desktop.screenshot_window",
      "desktop.screenshot_region",
      "desktop.ocr_window",
    ].includes(action)
  ) {
    return createObservation({
      channel: "ui",
      provider: "desktop",
      subject: stringField(args, "app_name"),
      state: "ready",
      data: result,
      evidence: evidenceForResult(result, "screenshot"),
    });
  }

  return null;
}

export function defaultVerificationForAction(
  action: string,
  args: JsonObject,
  result: unknown,
  observation: Observation | null,
): VerificationReceipt | null {
  if (!observation) return null;

  if (["fs.mkdir", "fs.append", "fs.edit", "fs.copy", "fs.move"].includes(action)) {
    return verifyObservation(observation, {
      id: `default:${action}`,
      expectations: [{ path: "data.exists", operator: "equals", expected: true }],
    });
  }

  if (action === "fs.write") {
    const bytes = asObject(result)?.bytes;
    const expectations: VerificationExpectation[] = [
      { path: "data.exists", operator: "equals", expected: true },
    ];
    if (typeof bytes === "number") {
      expectations.push({
        path: "data.size",
        operator: "equals" as const,
        expected: bytes,
      });
    }
    return verifyObservation(observation, {
      id: "default:fs.write",
      expectations,
    });
  }

  if (action === "fs.delete") {
    return verifyObservation(observation, {
      id: "default:fs.delete",
      expectations: [{ path: "data.exists", operator: "equals", expected: false }],
    });
  }

  if (action === "fs.batch_edit") {
    return verifyObservation(observation, {
      id: "default:fs.batch_edit",
      expectations: [{ path: "data.files", operator: "exists" }],
    });
  }

  if (action === "browser.type") {
    const spec: VerificationSpec = {
      id: "default:browser.type",
      description:
        "Verify that the targeted control contains exactly the requested value without persisting the raw typed text.",
      expectations: [
        {
          path: "data.target.exists",
          operator: "equals",
          expected: true,
        },
      ],
    };

    if (args.submit === true) {
      return uncertainVerificationReceipt(
        spec,
        "Typing followed by Enter can navigate, submit, or replace the target control; a semantic postcondition is required.",
        observation,
      );
    }

    const text = stringField(args, "text") ?? "";
    spec.expectations.push({
      path: "data.target.valueSha256",
      operator: "equals",
      expected: sha256Text(text),
    });
    spec.expectations.push({
      path: "data.target.valueLength",
      operator: "equals",
      expected: text.length,
    });
    return verifyObservation(observation, spec);
  }

  if (action === "browser.upload") {
    const files = Array.isArray(args.files) ? args.files : [];
    return verifyObservation(observation, {
      id: "default:browser.upload",
      description:
        "Verify the browser file input holds the requested number of files without exposing file paths.",
      expectations: [
        {
          path: "data.target.exists",
          operator: "equals",
          expected: true,
        },
        {
          path: "data.target.fileCount",
          operator: "equals",
          expected: files.length,
        },
      ],
    });
  }

  if (action === "browser.click") {
    return uncertainVerificationReceipt(
      {
        id: "default:browser.click",
        description:
          "A generic click has no universal business-success postcondition.",
        expectations: [
          {
            path: "data",
            operator: "exists",
          },
        ],
      },
      "The click executed and the page was re-observed, but Runtime cannot infer the intended business outcome. Supply an explicit verification spec.",
      observation,
    );
  }

  if (action === "desktop.clipboard_write") {
    const text =
      typeof args.text === "string" ? args.text : "";
    return verifyObservation(observation, {
      id: "default:desktop.clipboard_write",
      description:
        "Verify the clipboard contains exactly the requested text without persisting the raw clipboard content.",
      expectations: [
        {
          path: "data.clipboard.characters",
          operator: "equals",
          expected: text.length,
        },
        {
          path: "data.clipboard.sha256",
          operator: "equals",
          expected: sha256Text(text),
        },
      ],
    });
  }

  if (
    [
      "desktop.click",
      "desktop.type",
      "desktop.key",
      "desktop.click_element",
    ].includes(action)
  ) {
    return uncertainVerificationReceipt(
      {
        id: `default:${action}`,
        description:
          "Generic desktop input has no universal semantic postcondition.",
        expectations: [
          {
            path: "data",
            operator: "exists",
          },
        ],
      },
      "The desktop input action returned and Runtime attempted to re-observe the UI, but the intended application outcome cannot be inferred generically. Supply an explicit verification spec.",
      observation,
    );
  }

  return null;
}
