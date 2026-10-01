import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { browserProvider } from "../providers/browserProvider.js";
import { desktopProvider } from "../providers/desktopProvider.js";
import { getFileInfo } from "../tools/fileOps.js";
import { gitDiff, gitLog, gitStatus } from "../tools/gitOps.js";
import { observeProcess } from "../tools/shellOps.js";
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

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(filePath: string): Promise<string> {
  return sha256Bytes(await fs.readFile(filePath));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function numericField(value: unknown, key: string): number | undefined {
  const object = asObject(value);
  const field = object?.[key];
  return typeof field === "number" && Number.isFinite(field)
    ? field
    : undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
  const object = asObject(value);
  const field = object?.[key];
  return typeof field === "boolean" ? field : undefined;
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
  const targetData: JsonObject = { exists: true, ...info };
  const evidence: ObservationEvidence[] = [
    {
      kind: "file_metadata",
      ref: target,
      metadata: { size: info.size, type: info.type },
    },
  ];

  if (info.type === "file") {
    const digest = await fileSha256(target);
    targetData.sha256 = digest;
    evidence.push({
      kind: "file_content",
      ref: target,
      metadata: { sha256: digest, size: info.size },
    });
  }

  if (action === "fs.copy" || action === "fs.move") {
    const source =
      stringField(result, "source") ?? stringField(args, "source_path");
    if (source) {
      const sourceExists = await pathExists(source);
      const sourceData: JsonObject = { path: source, exists: sourceExists };
      if (sourceExists) {
        const sourceInfo = await getFileInfo(source);
        Object.assign(sourceData, sourceInfo);
        if (sourceInfo.type === "file") {
          sourceData.sha256 = await fileSha256(source);
        }
      }
      targetData.source = sourceData;
      if (
        action === "fs.copy" &&
        sourceData.sha256 &&
        targetData.sha256
      ) {
        targetData.copyDigestMatches =
          sourceData.sha256 === targetData.sha256;
      }
    }
  }

  return createObservation({
    channel: "file",
    provider: "filesystem",
    subject: target,
    data: targetData,
    evidence,
  });
}

async function observeBatchEdit(
  args: JsonObject,
  result: unknown,
): Promise<Observation | null> {
  const edits = Array.isArray(args.edits) ? args.edits : [];
  const resultRows = Array.isArray(result)
    ? result.filter(
        (item): item is JsonObject =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
      )
    : [];
  const expectedByPath = new Map<string, string>();
  for (const row of resultRows) {
    const rowPath = stringField(row, "path");
    const digest = stringField(row, "contentSha256");
    if (rowPath && digest) expectedByPath.set(rowPath, digest);
  }

  const files: JsonObject[] = [];
  const seen = new Set<string>();
  for (const edit of edits) {
    const filePath =
      edit && typeof edit === "object"
        ? (edit as JsonObject).path
        : undefined;
    if (typeof filePath !== "string" || seen.has(filePath)) continue;
    seen.add(filePath);

    const info = await getFileInfo(filePath);
    const digest = info.type === "file" ? await fileSha256(filePath) : undefined;
    const expectedDigest =
      expectedByPath.get(info.path) ?? expectedByPath.get(filePath);
    files.push({
      exists: true,
      ...info,
      ...(digest ? { sha256: digest } : {}),
      ...(expectedDigest ? { expectedSha256: expectedDigest } : {}),
      ...(digest && expectedDigest
        ? { digestMatches: digest === expectedDigest }
        : {}),
    });
  }

  const allDigestsMatch =
    files.length > 0 &&
    files.every(
      (entry) =>
        typeof entry.digestMatches === "boolean" &&
        entry.digestMatches === true,
    );

  return createObservation({
    channel: "file",
    provider: "filesystem",
    state: "ready",
    data: { files, allDigestsMatch },
    evidence: files.map((entry) => ({
      kind: "file_content" as const,
      ref: typeof entry.path === "string" ? entry.path : undefined,
      metadata: {
        sha256: entry.sha256,
        expectedSha256: entry.expectedSha256,
        digestMatches: entry.digestMatches,
      },
    })),
  });
}

async function observeGitAfterMutation(
  action: string,
  args: JsonObject,
  result: unknown,
): Promise<Observation | null> {
  const cwd = stringField(result, "cwd") ?? stringField(args, "cwd");
  if (!cwd) return null;

  const [status, workingDiff, stagedDiff, log] = await Promise.all([
    gitStatus(cwd),
    gitDiff(cwd, false),
    gitDiff(cwd, true),
    ["git.commit", "git.pull", "git.push"].includes(action)
      ? gitLog(cwd, 1)
      : Promise.resolve(null),
  ]);

  const resultExitCode = numericField(result, "exitCode");
  const stdout = stringField(result, "stdout") ?? "";
  const stderr = stringField(result, "stderr") ?? "";

  return createObservation({
    channel: "environment",
    provider: "git",
    subject: cwd,
    state: resultExitCode === 0 ? "ready" : "failed",
    data: {
      action,
      resultExitCode: resultExitCode ?? null,
      resultStdout: stdout,
      resultStderr: stderr,
      statusExitCode: status.exitCode,
      status: status.stdout,
      workingDiffExitCode: workingDiff.exitCode,
      workingDiff: workingDiff.stdout,
      stagedDiffExitCode: stagedDiff.exitCode,
      stagedDiff: stagedDiff.stdout,
      postMutationVisible:
        Boolean(status.stdout.trim()) ||
        Boolean(workingDiff.stdout.trim()) ||
        Boolean(stagedDiff.stdout.trim()),
      ...(log
        ? {
            logExitCode: log.exitCode,
            head: log.stdout,
          }
        : {}),
    },
    evidence: [
      {
        kind: "structured",
        metadata: {
          resultExitCode: resultExitCode ?? null,
          statusExitCode: status.exitCode,
          workingDiffExitCode: workingDiff.exitCode,
          stagedDiffExitCode: stagedDiff.exitCode,
          ...(log ? { logExitCode: log.exitCode } : {}),
        },
      },
      ...(status.stdout
        ? [{ kind: "text" as const, summary: status.stdout.slice(0, 500) }]
        : []),
      ...(log?.stdout
        ? [{ kind: "text" as const, summary: log.stdout.slice(0, 500) }]
        : []),
    ],
  });
}

async function observeShellExecOutcome(
  result: unknown,
): Promise<Observation | null> {
  const object = asObject(result);
  if (!object) return null;
  const exitCode =
    typeof object.exitCode === "number" ? object.exitCode : null;
  const timedOut = object.timedOut === true;
  const stdout = typeof object.stdout === "string" ? object.stdout : "";
  const stderr = typeof object.stderr === "string" ? object.stderr : "";
  const state = timedOut
    ? "timed_out"
    : exitCode === 0
      ? "finished"
      : typeof exitCode === "number"
        ? "failed"
        : "unknown";

  return createObservation({
    channel: "process",
    provider: "shell",
    subject:
      typeof object.command === "string" ? object.command.slice(0, 200) : undefined,
    state,
    data: {
      exitCode,
      timedOut,
      signal: object.signal ?? null,
      stdout,
      stderr,
      stdoutSha256: sha256Text(stdout),
      stderrSha256: sha256Text(stderr),
      stdoutCharacters: stdout.length,
      stderrCharacters: stderr.length,
    },
    evidence: [
      ...(stdout
        ? [{ kind: "stdout" as const, summary: stdout.slice(-500) }]
        : []),
      ...(stderr
        ? [{ kind: "stderr" as const, summary: stderr.slice(-500) }]
        : []),
      {
        kind: "exit_code",
        metadata: {
          exitCode,
          timedOut,
          signal: object.signal ?? null,
        },
      },
    ],
  });
}

async function observeShellStartOutcome(
  result: unknown,
): Promise<Observation | null> {
  const processId = stringField(result, "processId");
  if (!processId) return null;
  try {
    return await observeProcess(processId);
  } catch (error) {
    return createObservation({
      channel: "process",
      provider: "managed-process",
      subject: processId,
      state: "unknown",
      data: {
        processId,
        observationError:
          error instanceof Error ? error.message : String(error),
      },
      evidence: [
        {
          kind: "system",
          summary:
            "The process start action returned, but Runtime could not re-observe the managed process.",
        },
      ],
    });
  }
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
  if (action === "fs.batch_edit") {
    return await observeBatchEdit(args, result);
  }

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

  if (
    ["git.add", "git.commit", "git.patch", "git.pull", "git.push"].includes(
      action,
    )
  ) {
    return await observeGitAfterMutation(action, args, result);
  }

  if (action === "shell.exec") {
    return await observeShellExecOutcome(result);
  }
  if (action === "shell.start") {
    return await observeShellStartOutcome(result);
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

  if (action === "fs.mkdir") {
    return verifyObservation(observation, {
      id: "default:fs.mkdir",
      expectations: [
        { path: "data.exists", operator: "equals", expected: true },
        { path: "data.type", operator: "equals", expected: "directory" },
      ],
    });
  }

  if (["fs.write", "fs.append", "fs.edit"].includes(action)) {
    const expectedDigest = stringField(result, "contentSha256");
    const expectations: VerificationExpectation[] = [
      { path: "data.exists", operator: "equals", expected: true },
      { path: "data.type", operator: "equals", expected: "file" },
    ];
    if (expectedDigest) {
      expectations.push({
        path: "data.sha256",
        operator: "equals",
        expected: expectedDigest,
      });
    }
    if (action === "fs.write") {
      const bytes = numericField(result, "bytes");
      if (typeof bytes === "number") {
        expectations.push({
          path: "data.size",
          operator: "equals",
          expected: bytes,
        });
      }
    }
    return verifyObservation(observation, {
      id: `default:${action}`,
      description:
        "Re-read the persisted file and compare post-action content identity rather than trusting the mutation return value.",
      expectations,
    });
  }

  if (action === "fs.copy") {
    const expectations: VerificationExpectation[] = [
      { path: "data.exists", operator: "equals", expected: true },
      { path: "data.source.exists", operator: "equals", expected: true },
    ];
    if (booleanField(observation.data, "copyDigestMatches") !== undefined) {
      expectations.push({
        path: "data.copyDigestMatches",
        operator: "equals",
        expected: true,
      });
    }
    return verifyObservation(observation, {
      id: "default:fs.copy",
      expectations,
    });
  }

  if (action === "fs.move") {
    return verifyObservation(observation, {
      id: "default:fs.move",
      expectations: [
        { path: "data.exists", operator: "equals", expected: true },
        { path: "data.source.exists", operator: "equals", expected: false },
      ],
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
      description:
        "Re-read every edited file and compare its final content digest with the deterministic batch plan.",
      expectations: [
        { path: "data.files", operator: "exists" },
        {
          path: "data.allDigestsMatch",
          operator: "equals",
          expected: true,
        },
      ],
    });
  }

  if (action === "git.add") {
    return verifyObservation(observation, {
      id: "default:git.add",
      description:
        "Re-read repository status and the staged diff after git add.",
      expectations: [
        { path: "data.resultExitCode", operator: "equals", expected: 0 },
        { path: "data.statusExitCode", operator: "equals", expected: 0 },
        { path: "data.stagedDiffExitCode", operator: "equals", expected: 0 },
      ],
    });
  }

  if (action === "git.commit") {
    const message = stringField(args, "message") ?? "";
    const firstLine = message.split(/\r?\n/, 1)[0] ?? "";
    return verifyObservation(observation, {
      id: "default:git.commit",
      description:
        "Re-read HEAD after commit and verify the committed subject is observable.",
      expectations: [
        { path: "data.resultExitCode", operator: "equals", expected: 0 },
        { path: "data.statusExitCode", operator: "equals", expected: 0 },
        { path: "data.logExitCode", operator: "equals", expected: 0 },
        ...(firstLine
          ? [
              {
                path: "data.head",
                operator: "contains" as const,
                expected: firstLine,
              },
            ]
          : []),
      ],
    });
  }

  if (action === "git.patch") {
    return verifyObservation(observation, {
      id: "default:git.patch",
      description:
        "Re-read repository state after applying the patch and require a visible post-mutation state.",
      expectations: [
        { path: "data.resultExitCode", operator: "equals", expected: 0 },
        { path: "data.statusExitCode", operator: "equals", expected: 0 },
        {
          path: "data.postMutationVisible",
          operator: "equals",
          expected: true,
        },
      ],
    });
  }

  if (action === "git.pull") {
    return verifyObservation(observation, {
      id: "default:git.pull",
      description:
        "Verify the pull command completed and local HEAD can be re-observed.",
      expectations: [
        { path: "data.resultExitCode", operator: "equals", expected: 0 },
        { path: "data.statusExitCode", operator: "equals", expected: 0 },
        { path: "data.logExitCode", operator: "equals", expected: 0 },
      ],
    });
  }

  if (action === "git.push") {
    const resultExitCode = numericField(observation.data, "resultExitCode");
    if (resultExitCode !== 0) {
      return verifyObservation(observation, {
        id: "default:git.push",
        expectations: [
          { path: "data.resultExitCode", operator: "equals", expected: 0 },
        ],
      });
    }
    return uncertainVerificationReceipt(
      {
        id: "default:git.push",
        description:
          "A local git push process exit cannot by itself prove the intended remote repository state.",
        expectations: [{ path: "data", operator: "exists" }],
      },
      "The push command exited successfully and local state was re-observed, but Runtime did not independently query the remote ref. Supply an explicit remote postcondition for autonomous consequential workflows.",
      observation,
    );
  }

  if (action === "shell.start") {
    const processId = stringField(result, "processId");
    return verifyObservation(observation, {
      id: "default:shell.start",
      description:
        "Verify the durable managed process can be re-observed as running after launch.",
      expectations: [
        { path: "state", operator: "equals", expected: "running" },
        ...(processId
          ? [
              {
                path: "data.processId",
                operator: "equals" as const,
                expected: processId,
              },
            ]
          : []),
      ],
    });
  }

  if (action === "shell.exec") {
    if (observation.state !== "finished") {
      return verifyObservation(observation, {
        id: "default:shell.exec",
        expectations: [
          { path: "state", operator: "equals", expected: "finished" },
          { path: "data.exitCode", operator: "equals", expected: 0 },
          { path: "data.timedOut", operator: "equals", expected: false },
        ],
      });
    }
    return uncertainVerificationReceipt(
      {
        id: "default:shell.exec",
        description:
          "Process completion is execution evidence, not universal proof of the command's external business effect.",
        expectations: [{ path: "state", operator: "equals", expected: "finished" }],
      },
      "The command exited successfully and stdout/stderr were observed, but a generic shell command may affect files, network services, messages, deployments, or other external state. Supply an explicit verification spec for the intended outcome.",
      observation,
    );
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
