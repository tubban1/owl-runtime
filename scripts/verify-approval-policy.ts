import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeRoutedAction } from "../src/router/actionRouter.js";
import {
  ApprovalRequiredError,
  approveApproval,
  approvalFingerprint,
  listApprovals,
} from "../src/policy/approvalPolicy.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-approval-policy");
await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(scratch, { recursive: true });
process.env.OWL_STATE_ROOT = path.join(scratch, "state");
process.env.OWL_APPROVAL_MODE = "enforce";
process.env.ALLOWED_DIRECTORIES = scratch;
process.env.ALLOW_DELETE = "true";

const target = path.join(scratch, "delete-me.txt");
await fs.writeFile(target, "safe test\n");

let requestId = "";
try {
  await executeRoutedAction("fs.delete", { path: target });
  assert.fail("Expected approval requirement.");
} catch (error) {
  assert.ok(error instanceof ApprovalRequiredError);
  requestId = error.approval.id;
  assert.equal(error.approval.subject, "fs.delete");
  assert.equal(error.approval.state, "pending");
}
assert.equal(await fs.readFile(target, "utf8"), "safe test\n");

const pending = await listApprovals({ state: "pending" });
assert.equal(pending.length, 1);
assert.equal(pending[0]?.id, requestId);
await assert.rejects(() => approveApproval(requestId, false), /confirm=true/);
const approved = await approveApproval(requestId, true);
assert.equal(approved.state, "approved");

const executed = await executeRoutedAction("fs.delete", { path: target });
assert.equal(executed.approval.required, true);
assert.equal(executed.approval.receipt?.state, "consumed");
await assert.rejects(() => fs.access(target));

const consumed = await listApprovals({ state: "consumed" });
assert.equal(consumed.length, 1);
assert.equal(consumed[0]?.id, requestId);

const fingerprintA = approvalFingerprint("action", "fs.delete", { path: "/a", recursive: false });
const fingerprintB = approvalFingerprint("action", "fs.delete", { recursive: false, path: "/a" });
const fingerprintC = approvalFingerprint("action", "fs.delete", { path: "/b", recursive: false });
assert.equal(fingerprintA, fingerprintB);
assert.notEqual(fingerprintA, fingerprintC);

process.env.OWL_APPROVAL_MODE = "compat";
const compatTarget = path.join(scratch, "compat-delete.txt");
await fs.writeFile(compatTarget, "compat\n");
const compat = await executeRoutedAction("fs.delete", { path: compatTarget });
assert.equal(compat.approval.required, false);

console.log(JSON.stringify({
  ok: true,
  enforceModeBlocksBeforeSideEffect: true,
  explicitConfirmRequired: true,
  oneTimeReceipt: true,
  exactArgsFingerprint: true,
  compatibilityModePreserved: true,
}, null, 2));

await fs.rm(scratch, { recursive: true, force: true });
