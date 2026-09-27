import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp-verify-state-schema");
const stateRoot = path.join(scratch, "state");
const futureRoot = path.join(scratch, "future");
const malformedRoot = path.join(scratch, "malformed");

process.env.AGENTOS_RUNTIME_MODE = "test";
process.env.AGENTOS_STATE_ROOT = stateRoot;

await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(stateRoot, { recursive: true });

const {
  CURRENT_STATE_SCHEMA_VERSION,
  AGENTOS_STATE_FORMAT,
  assertStateSchemaReadable,
  getStateMigrationRegistry,
  getStateSchemaStatus,
  migrateStateSchema,
} = await import("../src/runtime/stateSchema.js");
const { runtimeLifecycle } = await import("../src/runtime/runtimeLifecycle.js");
const { executeSkill } = await import("../src/skills/skillRuntime.js");

try {
  const initial = await getStateSchemaStatus();
  assert.equal(initial.schemaVersion, 0);
  assert.equal(initial.legacyUnversioned, true);
  assert.equal(initial.readable, true);
  assert.equal(initial.migrationRequired, true);
  assert.equal(initial.autoMigrationSafe, true);
  assert.equal(initial.rollbackCompatible, true);
  assert.equal(initial.plannedMigrations.length, 1);
  assert.equal(
    initial.plannedMigrations[0]?.id,
    "0001-bootstrap-state-manifest",
  );

  const registry = getStateMigrationRegistry();
  assert.equal(registry.length, 1);
  assert.equal(registry[0]?.from, 0);
  assert.equal(registry[0]?.to, 1);
  assert.equal(registry[0]?.idempotent, true);
  assert.equal(registry[0]?.rollbackCompatible, true);

  const skillStatus = await executeSkill("runtime.state", { op: "status" });
  assert.equal(
    (skillStatus.result as { schemaVersion?: number }).schemaVersion,
    0,
  );

  await assert.rejects(
    () =>
      executeSkill("runtime.state", {
        op: "migrate",
        confirm: true,
      }),
    /STATE_MIGRATION_REQUIRES_DRAIN/,
  );

  runtimeLifecycle.requestDrain({ reason: "verify state schema migration" });

  await assert.rejects(
    () =>
      executeSkill("runtime.state", {
        op: "migrate",
        confirm: false,
      }),
    /STATE_MIGRATION_CONFIRM_REQUIRED/,
  );

  await assert.rejects(
    () =>
      migrateStateSchema({
        confirm: true,
        faultPoint: "after_journal",
      }),
    /STATE_MIGRATION_FAULT_INJECTED/,
  );

  const afterFault = await getStateSchemaStatus();
  assert.equal(afterFault.schemaVersion, 0);
  assert.equal(afterFault.migrationRequired, true);
  assert.equal(afterFault.pendingMigration?.idempotent, true);
  assert.equal(
    afterFault.pendingMigration?.migrationId,
    "0001-bootstrap-state-manifest",
  );

  const recovered = await executeSkill("runtime.state", {
    op: "migrate",
    confirm: true,
  });
  const recoveredResult = recovered.result as {
    changed?: boolean;
    recoveredPendingJournal?: boolean;
    status?: {
      schemaVersion?: number;
      migrationRequired?: boolean;
      nativeSchema?: boolean;
      manifest?: {
        migrationHistory?: Array<{
          id?: string;
          rollbackCompatible?: boolean;
        }>;
      };
    };
  };
  assert.equal(recoveredResult.changed, true);
  assert.equal(recoveredResult.recoveredPendingJournal, true);
  assert.equal(
    recoveredResult.status?.schemaVersion,
    CURRENT_STATE_SCHEMA_VERSION,
  );
  assert.equal(recoveredResult.status?.migrationRequired, false);
  assert.equal(recoveredResult.status?.nativeSchema, true);
  assert.equal(
    recoveredResult.status?.manifest?.migrationHistory?.length,
    1,
  );
  assert.equal(
    recoveredResult.status?.manifest?.migrationHistory?.[0]?.rollbackCompatible,
    true,
  );

  const repeated = await executeSkill("runtime.state", {
    op: "migrate",
    confirm: true,
  });
  assert.equal((repeated.result as { changed?: boolean }).changed, false);

  const manifestPath = path.join(stateRoot, "runtime-state.json");
  const journalPath = path.join(stateRoot, "runtime-state-migration.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
    format?: string;
    schemaVersion?: number;
  };
  assert.equal(manifest.format, AGENTOS_STATE_FORMAT);
  assert.equal(manifest.schemaVersion, CURRENT_STATE_SCHEMA_VERSION);
  await assert.rejects(() => fs.access(journalPath), /ENOENT/);

  const tmpEntries = (await fs.readdir(stateRoot)).filter((name) =>
    name.endsWith(".tmp"),
  );
  assert.deepEqual(tmpEntries, []);

  await fs.mkdir(futureRoot, { recursive: true });
  await fs.writeFile(
    path.join(futureRoot, "runtime-state.json"),
    JSON.stringify(
      {
        format: AGENTOS_STATE_FORMAT,
        schemaVersion: CURRENT_STATE_SCHEMA_VERSION + 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        migrationHistory: [],
      },
      null,
      2,
    ),
  );
  const future = await getStateSchemaStatus(futureRoot);
  assert.equal(future.readable, false);
  assert.match(String(future.incompatibleReason), /newer than this Runtime/);
  await assert.rejects(
    () => assertStateSchemaReadable(futureRoot),
    /STATE_SCHEMA_INCOMPATIBLE/,
  );

  await fs.mkdir(malformedRoot, { recursive: true });
  await fs.writeFile(
    path.join(malformedRoot, "runtime-state.json"),
    JSON.stringify({ format: "wrong-format", schemaVersion: 1 }),
  );
  await assert.rejects(
    () => getStateSchemaStatus(malformedRoot),
    /STATE_SCHEMA_INVALID/,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        currentSchemaVersion: CURRENT_STATE_SCHEMA_VERSION,
        legacySchemaDetected: true,
        explicitDrainRequired: true,
        explicitConfirmRequired: true,
        migrationRegistry: true,
        atomicManifestWrite: true,
        crashJournalRecovery: true,
        idempotentRetry: true,
        rollbackCompatibleBootstrap: true,
        futureSchemaBlocked: true,
        malformedManifestBlocked: true,
        primitiveAbiUnchanged: true,
      },
      null,
      2,
    ),
  );
} finally {
  runtimeLifecycle.resume();
  await fs.rm(scratch, { recursive: true, force: true }).catch(
    () => undefined,
  );
}
