import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ActionContract } from "../runtime/actionContracts.js";
import { currentExecutionContext } from "../runtime/executionContext.js";
import { runtimeStatePath } from "../runtime/runtimePaths.js";

export type ApprovalMode = "compat" | "enforce";
export type ApprovalState = "pending" | "approved" | "consumed" | "denied" | "expired";
export type ApprovalSubjectType = "action" | "skill";

export type ApprovalRecord = {
  version: 1;
  id: string;
  subjectType: ApprovalSubjectType;
  subject: string;
  fingerprint: string;
  riskLevel: ActionContract["riskLevel"];
  sideEffects: string[];
  state: ApprovalState;
  requestedAt: string;
  expiresAt: string;
  approvedAt?: string;
  deniedAt?: string;
  consumedAt?: string;
  ownerSessionId: string;
  ownerTaskId?: string;
  reason: string;
};

const DEFAULT_APPROVAL_ACTIONS = ["fs.delete", "git.push", "tx.rollback"];

function approvalDir() {
  return runtimeStatePath("approvals");
}

function approvalMode(): ApprovalMode {
  const raw = process.env.OWL_APPROVAL_MODE?.trim().toLowerCase();
  return raw === "enforce" ? "enforce" : "compat";
}

function csvEnv(name: string): string[] | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function approvalFingerprint(
  subjectType: ApprovalSubjectType,
  subject: string,
  args: unknown,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ subjectType, subject, args: stableValue(args) }))
    .digest("hex");
}

function recordPath(id: string) {
  if (!/^approval_[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error("Invalid approval id.");
  }
  return path.join(approvalDir(), `${id}.json`);
}

async function ensureDir() {
  await fs.mkdir(approvalDir(), { recursive: true, mode: 0o700 });
  await fs.chmod(approvalDir(), 0o700).catch(() => undefined);
}

async function writeRecord(record: ApprovalRecord) {
  await ensureDir();
  const target = recordPath(record.id);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(record, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(temp, target);
  await fs.chmod(target, 0o600).catch(() => undefined);
}

export async function readApproval(id: string): Promise<ApprovalRecord> {
  await ensureDir();
  const record = JSON.parse(await fs.readFile(recordPath(id), "utf8")) as ApprovalRecord;
  return await expireIfNeeded(record);
}

async function expireIfNeeded(record: ApprovalRecord) {
  if (["pending", "approved"].includes(record.state) && Date.parse(record.expiresAt) <= Date.now()) {
    record.state = "expired";
    await writeRecord(record);
  }
  return record;
}

export async function listApprovals(options?: { state?: ApprovalState }) {
  await ensureDir();
  const records: ApprovalRecord[] = [];
  for (const name of await fs.readdir(approvalDir())) {
    if (!name.endsWith(".json")) continue;
    try {
      records.push(await expireIfNeeded(JSON.parse(
        await fs.readFile(path.join(approvalDir(), name), "utf8"),
      ) as ApprovalRecord));
    } catch {
      // One malformed record must not hide healthy approval records.
    }
  }
  return records
    .filter((record) => !options?.state || record.state === options.state)
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

function actionRequiresApproval(action: string, contract: Pick<ActionContract, "sideEffects">) {
  if (approvalMode() !== "enforce") return false;
  const configuredActions = csvEnv("OWL_APPROVAL_ACTIONS") ?? DEFAULT_APPROVAL_ACTIONS;
  const configuredEffects = csvEnv("OWL_APPROVAL_SIDE_EFFECTS") ?? [];
  return configuredActions.includes(action) ||
    contract.sideEffects.some((effect) => configuredEffects.includes(effect));
}

function skillRequiresApproval(skill: string, args: Record<string, unknown>) {
  if (approvalMode() !== "enforce") return false;
  const configuredSkills = csvEnv("OWL_APPROVAL_SKILLS");
  if (configuredSkills?.includes(skill)) return true;
  if (skill === "wechat.send") return args.send === true;
  if (skill === "wechat.session") return args.op === "send" && args.confirm === true;
  if (skill === "email.compose") return args.send === true;
  if (skill === "xhs.publish") return args.publish === true;
  return false;
}

async function findMatching(fingerprint: string) {
  const records = await listApprovals();
  return records.find(
    (record) => record.fingerprint === fingerprint &&
      (record.state === "approved" || record.state === "pending"),
  );
}

async function createRequest(input: {
  subjectType: ApprovalSubjectType;
  subject: string;
  args: unknown;
  contract: Pick<ActionContract, "riskLevel" | "sideEffects">;
}) {
  const context = currentExecutionContext();
  const now = new Date();
  const fingerprint = approvalFingerprint(input.subjectType, input.subject, input.args);
  const existing = await findMatching(fingerprint);
  if (existing) return existing;
  const record: ApprovalRecord = {
    version: 1,
    id: `approval_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    subjectType: input.subjectType,
    subject: input.subject,
    fingerprint,
    riskLevel: input.contract.riskLevel,
    sideEffects: [...input.contract.sideEffects],
    state: "pending",
    requestedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
    ownerSessionId: context.sessionId,
    ...(context.taskId ? { ownerTaskId: context.taskId } : {}),
    reason: `${input.subjectType} ${input.subject} requires explicit approval under the active OWL policy.`,
  };
  await writeRecord(record);
  return record;
}

export class ApprovalRequiredError extends Error {
  readonly approval: ApprovalRecord;
  constructor(record: ApprovalRecord) {
    super(`APPROVAL_REQUIRED: ${record.id} ${record.subjectType}:${record.subject} expires=${record.expiresAt}`);
    this.name = "ApprovalRequiredError";
    this.approval = record;
  }
}

async function authorize(input: {
  required: boolean;
  subjectType: ApprovalSubjectType;
  subject: string;
  args: unknown;
  contract: Pick<ActionContract, "riskLevel" | "sideEffects">;
}) {
  if (!input.required) return { required: false, mode: approvalMode(), receipt: null };
  const fingerprint = approvalFingerprint(input.subjectType, input.subject, input.args);
  const existing = await findMatching(fingerprint);
  if (existing?.state === "approved") {
    existing.state = "consumed";
    existing.consumedAt = new Date().toISOString();
    await writeRecord(existing);
    return { required: true, mode: approvalMode(), receipt: existing };
  }
  const request = existing ?? await createRequest(input);
  throw new ApprovalRequiredError(request);
}

export async function authorizeAction(
  action: string,
  args: unknown,
  contract: Pick<ActionContract, "riskLevel" | "sideEffects">,
) {
  return await authorize({
    required: actionRequiresApproval(action, contract),
    subjectType: "action",
    subject: action,
    args,
    contract,
  });
}

export async function authorizeSkill(
  skill: string,
  args: Record<string, unknown>,
  contract: Pick<ActionContract, "riskLevel" | "sideEffects">,
) {
  return await authorize({
    required: skillRequiresApproval(skill, args),
    subjectType: "skill",
    subject: skill,
    args,
    contract,
  });
}

export async function approveApproval(id: string, confirm: boolean) {
  if (!confirm) throw new Error("Approval requires confirm=true.");
  const record = await readApproval(id);
  if (record.state !== "pending") {
    throw new Error(`Approval ${id} is ${record.state}; only pending requests can be approved.`);
  }
  record.state = "approved";
  record.approvedAt = new Date().toISOString();
  await writeRecord(record);
  return record;
}

export async function denyApproval(id: string, confirm: boolean) {
  if (!confirm) throw new Error("Denial requires confirm=true.");
  const record = await readApproval(id);
  if (record.state !== "pending") {
    throw new Error(`Approval ${id} is ${record.state}; only pending requests can be denied.`);
  }
  record.state = "denied";
  record.deniedAt = new Date().toISOString();
  await writeRecord(record);
  return record;
}

export function getApprovalPolicyStatus() {
  return {
    mode: approvalMode(),
    defaultApprovalActions: [...DEFAULT_APPROVAL_ACTIONS],
    configuredApprovalActions: csvEnv("OWL_APPROVAL_ACTIONS") ?? null,
    configuredApprovalSideEffects: csvEnv("OWL_APPROVAL_SIDE_EFFECTS") ?? null,
    configuredApprovalSkills: csvEnv("OWL_APPROVAL_SKILLS") ?? null,
    semanticDefaults: ["wechat.send(send=true)", "wechat.session(send)", "email.compose(send=true)", "xhs.publish(publish=true)"],
    receipt: { oneTime: true, ttlMinutes: 15, boundToExactArgsFingerprint: true },
  };
}
