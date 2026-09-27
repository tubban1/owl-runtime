import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runtimeStateRoot } from "./runtimePaths.js";

export const AGENTOS_STATE_FORMAT = "agentos-runtime-state";
export const CURRENT_STATE_SCHEMA_VERSION = 1;
export const MIN_READABLE_STATE_SCHEMA_VERSION = 0;

const MANIFEST_FILE = "runtime-state.json";
const JOURNAL_FILE = "runtime-state-migration.json";

export type StateMigrationHistoryEntry = {
  id: string;
  from: number;
  to: number;
  appliedAt: string;
  runtimeVersion: string;
  rollbackCompatible: boolean;
};

export type RuntimeStateManifest = {
  format: typeof AGENTOS_STATE_FORMAT;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  migrationHistory: StateMigrationHistoryEntry[];
};

export type StateMigrationJournal = {
  format: "agentos-runtime-state-migration";
  migrationId: string;
  from: number;
  to: number;
  startedAt: string;
  runtimeVersion: string;
  idempotent: boolean;
  rollbackCompatible: boolean;
};

export type StateMigrationDescriptor = {
  id: string;
  from: number;
  to: number;
  description: string;
  autoSafe: boolean;
  rollbackCompatible: boolean;
  idempotent: boolean;
};

const MIGRATIONS: StateMigrationDescriptor[] = [
  {
    id: "0001-bootstrap-state-manifest",
    from: 0,
    to: 1,
    description:
      "Create the AgentOS Runtime state-schema manifest without changing existing Task, Memory, Scheduler, Loop, Session, or Process data.",
    autoSafe: true,
    rollbackCompatible: true,
    idempotent: true,
  },
];

function manifestPath(root = runtimeStateRoot()): string {
  return path.join(root, MANIFEST_FILE);
}

function journalPath(root = runtimeStateRoot()): string {
  return path.join(root, JOURNAL_FILE);
}

function runtimeVersion(): string {
  return process.env.AGENTOS_RUNTIME_VERSION?.trim() || "0.9.14";
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function validateManifest(raw: RuntimeStateManifest): RuntimeStateManifest {
  if (!raw || raw.format !== AGENTOS_STATE_FORMAT) {
    throw new Error(
      `STATE_SCHEMA_INVALID: ${MANIFEST_FILE} has an unsupported format.`,
    );
  }
  if (
    !Number.isInteger(raw.schemaVersion) ||
    raw.schemaVersion < 1 ||
    !Array.isArray(raw.migrationHistory)
  ) {
    throw new Error(
      `STATE_SCHEMA_INVALID: ${MANIFEST_FILE} has invalid schema metadata.`,
    );
  }
  return raw;
}

function validateJournal(
  raw: StateMigrationJournal,
): StateMigrationJournal {
  if (
    !raw ||
    raw.format !== "agentos-runtime-state-migration" ||
    !raw.migrationId ||
    !Number.isInteger(raw.from) ||
    !Number.isInteger(raw.to)
  ) {
    throw new Error(
      `STATE_MIGRATION_JOURNAL_INVALID: ${JOURNAL_FILE} is malformed.`,
    );
  }
  return raw;
}

async function readManifest(
  root = runtimeStateRoot(),
): Promise<RuntimeStateManifest | null> {
  const raw = await readJsonIfExists<RuntimeStateManifest>(manifestPath(root));
  return raw ? validateManifest(raw) : null;
}

async function readJournal(
  root = runtimeStateRoot(),
): Promise<StateMigrationJournal | null> {
  const raw = await readJsonIfExists<StateMigrationJournal>(journalPath(root));
  return raw ? validateJournal(raw) : null;
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tmp = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(tmp, filePath);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

function migrationPath(from: number): StateMigrationDescriptor[] {
  const path: StateMigrationDescriptor[] = [];
  let version = from;
  const seen = new Set<number>();

  while (version < CURRENT_STATE_SCHEMA_VERSION) {
    if (seen.has(version)) {
      throw new Error(
        `STATE_SCHEMA_REGISTRY_INVALID: migration cycle at schema ${version}.`,
      );
    }
    seen.add(version);

    const candidates = MIGRATIONS.filter((migration) => migration.from === version);
    if (candidates.length !== 1) {
      throw new Error(
        `STATE_SCHEMA_REGISTRY_INVALID: expected exactly one migration from schema ${version}, found ${candidates.length}.`,
      );
    }

    const migration = candidates[0];
    if (!migration || migration.to <= migration.from) {
      throw new Error(
        `STATE_SCHEMA_REGISTRY_INVALID: migration from schema ${version} does not advance.`,
      );
    }
    path.push(migration);
    version = migration.to;
  }

  return path;
}

function manifestForMigration(
  previous: RuntimeStateManifest | null,
  migration: StateMigrationDescriptor,
): RuntimeStateManifest {
  const now = new Date().toISOString();
  const createdAt = previous?.createdAt ?? now;
  const history = previous?.migrationHistory ?? [];

  return {
    format: AGENTOS_STATE_FORMAT,
    schemaVersion: migration.to,
    createdAt,
    updatedAt: now,
    migrationHistory: [
      ...history,
      {
        id: migration.id,
        from: migration.from,
        to: migration.to,
        appliedAt: now,
        runtimeVersion: runtimeVersion(),
        rollbackCompatible: migration.rollbackCompatible,
      },
    ],
  };
}

export async function getStateSchemaStatus(
  root = runtimeStateRoot(),
) {
  const manifest = await readManifest(root);
  const journal = await readJournal(root);
  const schemaVersion = manifest?.schemaVersion ?? 0;
  const readable =
    schemaVersion >= MIN_READABLE_STATE_SCHEMA_VERSION &&
    schemaVersion <= CURRENT_STATE_SCHEMA_VERSION;

  let plannedMigrations: StateMigrationDescriptor[] = [];
  let planningError: string | null = null;
  if (readable && schemaVersion < CURRENT_STATE_SCHEMA_VERSION) {
    try {
      plannedMigrations = migrationPath(schemaVersion);
    } catch (error) {
      planningError =
        error instanceof Error ? error.message : String(error);
    }
  }

  const journalAlreadyCommitted =
    Boolean(journal) &&
    schemaVersion >= (journal?.to ?? Number.POSITIVE_INFINITY);

  const pendingJournal =
    journal && !journalAlreadyCommitted ? journal : null;

  return {
    format: AGENTOS_STATE_FORMAT,
    manifestPath: manifestPath(root),
    journalPath: journalPath(root),
    schemaVersion,
    currentSchemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    minimumReadableSchemaVersion: MIN_READABLE_STATE_SCHEMA_VERSION,
    legacyUnversioned: manifest === null,
    readable,
    migrationRequired:
      readable &&
      planningError === null &&
      schemaVersion < CURRENT_STATE_SCHEMA_VERSION,
    nativeSchema: schemaVersion === CURRENT_STATE_SCHEMA_VERSION,
    plannedMigrations,
    autoMigrationSafe:
      planningError === null &&
      plannedMigrations.every((migration) => migration.autoSafe),
    rollbackCompatible:
      planningError === null &&
      plannedMigrations.every((migration) => migration.rollbackCompatible),
    pendingMigration: pendingJournal,
    recoverableCommittedJournal: journalAlreadyCommitted,
    planningError,
    incompatibleReason:
      schemaVersion > CURRENT_STATE_SCHEMA_VERSION
        ? `State schema ${schemaVersion} is newer than this Runtime supports (${CURRENT_STATE_SCHEMA_VERSION}).`
        : schemaVersion < MIN_READABLE_STATE_SCHEMA_VERSION
          ? `State schema ${schemaVersion} is older than the minimum readable schema (${MIN_READABLE_STATE_SCHEMA_VERSION}).`
          : planningError,
    manifest,
  };
}

async function reconcileCommittedJournal(root: string): Promise<boolean> {
  const manifest = await readManifest(root);
  const journal = await readJournal(root);
  if (!journal || !manifest) return false;
  if (manifest.schemaVersion < journal.to) return false;

  await fs.rm(journalPath(root), { force: true });
  return true;
}

export async function migrateStateSchema(options: {
  root?: string;
  confirm: boolean;
  allowUnsafe?: boolean;
  faultPoint?: "after_journal";
}) {
  if (!options.confirm) {
    throw new Error(
      "STATE_MIGRATION_CONFIRM_REQUIRED: migrate requires confirm=true.",
    );
  }

  const root = options.root ?? runtimeStateRoot();
  await reconcileCommittedJournal(root);

  let status = await getStateSchemaStatus(root);
  if (!status.readable) {
    throw new Error(
      `STATE_SCHEMA_INCOMPATIBLE: ${status.incompatibleReason ?? "unsupported state schema"}`,
    );
  }
  if (status.planningError) {
    throw new Error(status.planningError);
  }
  if (status.pendingMigration && !status.pendingMigration.idempotent) {
    throw new Error(
      `STATE_MIGRATION_RECOVERY_REQUIRED: pending migration ${status.pendingMigration.migrationId} is not idempotent.`,
    );
  }
  if (!status.migrationRequired) {
    return {
      changed: false,
      recoveredPendingJournal: false,
      status,
    };
  }
  if (
    !options.allowUnsafe &&
    (!status.autoMigrationSafe || !status.rollbackCompatible)
  ) {
    throw new Error(
      "STATE_MIGRATION_NOT_AUTO_SAFE: migration requires an explicit manual migration protocol.",
    );
  }

  let recoveredPendingJournal = Boolean(status.pendingMigration);
  let manifest = status.manifest;

  for (const migration of status.plannedMigrations) {
    if (manifest && manifest.schemaVersion >= migration.to) continue;

    const journal: StateMigrationJournal = {
      format: "agentos-runtime-state-migration",
      migrationId: migration.id,
      from: migration.from,
      to: migration.to,
      startedAt: new Date().toISOString(),
      runtimeVersion: runtimeVersion(),
      idempotent: migration.idempotent,
      rollbackCompatible: migration.rollbackCompatible,
    };
    await atomicWriteJson(journalPath(root), journal);

    if (options.faultPoint === "after_journal") {
      throw new Error(
        "STATE_MIGRATION_FAULT_INJECTED: after_journal",
      );
    }

    const nextManifest = manifestForMigration(manifest, migration);
    await atomicWriteJson(manifestPath(root), nextManifest);
    manifest = nextManifest;
    await fs.rm(journalPath(root), { force: true });
  }

  status = await getStateSchemaStatus(root);
  if (
    status.schemaVersion !== CURRENT_STATE_SCHEMA_VERSION ||
    status.migrationRequired
  ) {
    throw new Error(
      "STATE_MIGRATION_VERIFY_FAILED: state schema did not reach the current version.",
    );
  }

  return {
    changed: true,
    recoveredPendingJournal,
    status,
  };
}

export async function assertStateSchemaReadable(
  root = runtimeStateRoot(),
) {
  const status = await getStateSchemaStatus(root);
  if (!status.readable || status.planningError) {
    throw new Error(
      `STATE_SCHEMA_INCOMPATIBLE: ${status.incompatibleReason ?? status.planningError ?? "unsupported state schema"}`,
    );
  }
  return status;
}

export function getStateMigrationRegistry() {
  return MIGRATIONS.map((migration) => ({ ...migration }));
}
