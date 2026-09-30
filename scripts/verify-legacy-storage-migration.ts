import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  inventoryLegacyStorage,
  migrateLegacyStorage,
} from "../src/storage/legacyStorageMigration.js";
import { listStorageReferences } from "../src/storage/storageRetention.js";

const work = await fs.mkdtemp(path.join(os.tmpdir(), "owl-legacy-migration-"));
const computerMcp = path.join(work, ".computer-mcp");
const agentos = path.join(work, ".agentos");
const owlRuntime = path.join(work, ".owl-runtime");
const storageRoot = path.join(work, "OWL LAB");

try {
  await fs.mkdir(path.join(computerMcp, "staging", "task_1", "outputs"), {
    recursive: true,
  });
  await fs.mkdir(path.join(agentos, "evidence"), { recursive: true });
  await fs.mkdir(path.join(agentos, "cache"), { recursive: true });
  await fs.mkdir(path.join(computerMcp, "tasks"), { recursive: true });
  await fs.mkdir(path.join(owlRuntime, "scratch"), { recursive: true });

  await fs.writeFile(
    path.join(computerMcp, "staging", "task_1", "outputs", "result.bin"),
    "duplicate durable bytes",
  );
  await fs.writeFile(
    path.join(agentos, "evidence", "proof.bin"),
    "duplicate durable bytes",
  );
  await fs.writeFile(path.join(agentos, "cache", "download.tmp"), "cache");
  await fs.writeFile(path.join(computerMcp, "tasks", "task_a.task"), "opaque-state");
  await fs.writeFile(path.join(owlRuntime, "scratch", "unknown.txt"), "review-me");

  const roots = {
    "computer-mcp": computerMcp,
    agentos,
    "owl-runtime": owlRuntime,
  };

  const inventory = await inventoryLegacyStorage({ roots });
  assert.equal(inventory.version, 1);
  assert.equal(inventory.roots.every((root) => root.exists), true);

  const migrateItems = inventory.items.filter(
    (item) => item.migrationDecision === "migrate",
  );
  const discardable = inventory.items.filter(
    (item) => item.migrationDecision === "discardable",
  );
  const review = inventory.items.filter(
    (item) => item.migrationDecision === "review",
  );
  assert.equal(migrateItems.length, 2);
  assert.equal(discardable.length, 1);
  assert.equal(review.length, 2);
  assert.equal(inventory.items.some((item) => path.isAbsolute(item.relativePath)), false);
  assert.equal(
    inventory.items.some((item) => item.relativePath.endsWith("proof-link.bin")),
    false,
  );

  await assert.rejects(
    () =>
      migrateLegacyStorage({
        inventory,
        roots,
        storageRoot,
        confirm: false,
      }),
    /CONFIRM_REQUIRED/,
  );

  const changedItem = migrateItems[0]!;
  const changedRoot = roots[changedItem.source];
  const changedPath = path.join(changedRoot, changedItem.relativePath);
  await fs.writeFile(changedPath, "changed after inventory");
  await assert.rejects(
    () =>
      migrateLegacyStorage({
        inventory,
        roots,
        storageRoot,
        confirm: true,
      }),
    /CHANGED_SINCE_INVENTORY/,
  );
  await fs.writeFile(changedPath, "duplicate durable bytes");

  const receipt = await migrateLegacyStorage({
    inventory,
    roots,
    storageRoot,
    confirm: true,
  });
  assert.equal(receipt.legacyDeleted, false);
  assert.equal(receipt.migrated.length, 2);
  assert.equal(receipt.objectIds.length, 1);
  assert.ok(receipt.deduplicatedBytes > 0);
  assert.equal(receipt.reviewBytes, inventory.totals.reviewBytes);

  const refs = await listStorageReferences(storageRoot);
  assert.equal(refs.length, 2);
  assert.equal(refs[0]?.artifact.objectId, refs[1]?.artifact.objectId);

  await fs.access(
    path.join(computerMcp, "staging", "task_1", "outputs", "result.bin"),
  );
  await fs.access(path.join(agentos, "evidence", "proof.bin"));
  await fs.access(path.join(agentos, "cache", "download.tmp"));

  console.log(
    JSON.stringify(
      {
        ok: true,
        legacyStorageMigrationVersion: 1,
        inventoryIsReadOnly: true,
        symlinksSkipped: true,
        unknownStateRequiresReview: true,
        digestChangeFailsClosed: true,
        duplicateBytesDeduplicated: true,
        sourceFilesNotDeleted: true,
        explicitConfirmationRequired: true,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(work, { recursive: true, force: true });
}
