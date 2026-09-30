import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const STORAGE_DB_KEY_SERVICE = "fan.fde.owl.runtime.storage-metadata";
export const STORAGE_DB_KEY_ACCOUNT = "default";

export type StorageDatabaseKey = { keyId: string; version: 1; keyHex: string };
export interface StorageKeyProvider {
  getOrCreate(): Promise<StorageDatabaseKey>;
  get(): Promise<StorageDatabaseKey>;
}

export type StorageKeyRotation = {
  rotationId: string;
  next: StorageDatabaseKey;
};

export interface RotatableStorageKeyProvider extends StorageKeyProvider {
  prepareRotation(): Promise<StorageKeyRotation>;
  activateRotation(rotation: StorageKeyRotation): Promise<void>;
  finalizeRotation(rotationId: string): Promise<void>;
  rollbackRotation(rotationId: string): Promise<void>;
}

function validateKeyHex(value: string): string {
  const key = value.trim();
  if (!/^[a-f0-9]{64}$/.test(key)) {
    throw new Error("STORAGE_KEY_INVALID: expected a 256-bit lowercase hex key.");
  }
  return key;
}

function keyResult(keyHex: string, keyId = `${STORAGE_DB_KEY_SERVICE}:v1`): StorageDatabaseKey {
  return { keyId, version: 1, keyHex: validateKeyHex(keyHex) };
}

function keychainExitCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : null;
}

function rotationAccounts(rotationId: string) {
  if (!/^[a-f0-9]{32}$/.test(rotationId)) {
    throw new Error("STORAGE_KEY_ROTATION_INVALID: malformed rotation id.");
  }
  return {
    staged: `${STORAGE_DB_KEY_ACCOUNT}.rotation.${rotationId}.staged`,
    recovery: `${STORAGE_DB_KEY_ACCOUNT}.rotation.${rotationId}.recovery`,
  };
}

export class MacOSKeychainStorageKeyProvider implements RotatableStorageKeyProvider {
  private assertPlatform(): void {
    if (process.platform !== "darwin") {
      throw new Error(
        "STORAGE_KEY_PROVIDER_UNAVAILABLE: macOS Keychain provider requires darwin.",
      );
    }
  }

  private async readAccount(account: string): Promise<string | null> {
    this.assertPlatform();
    try {
      const { stdout } = await execFileAsync(
        "/usr/bin/security",
        ["find-generic-password", "-s", STORAGE_DB_KEY_SERVICE, "-a", account, "-w"],
        { encoding: "utf8", timeout: 5000, maxBuffer: 4096 },
      );
      return validateKeyHex(stdout);
    } catch (error) {
      if (keychainExitCode(error) === 44) return null;
      if (error instanceof Error && error.message.startsWith("STORAGE_KEY_INVALID:")) {
        throw error;
      }
      throw new Error(
        "STORAGE_KEY_UNAVAILABLE: encrypted metadata key could not be read from macOS Keychain.",
        { cause: error },
      );
    }
  }

  private async writeAccount(account: string, keyHex: string, update = false): Promise<void> {
    this.assertPlatform();
    const args = ["add-generic-password"];
    if (update) args.push("-U");
    args.push(
      "-s",
      STORAGE_DB_KEY_SERVICE,
      "-a",
      account,
      "-w",
      validateKeyHex(keyHex),
    );
    await execFileAsync("/usr/bin/security", args, {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4096,
    });
  }

  private async deleteAccount(account: string): Promise<void> {
    this.assertPlatform();
    try {
      await execFileAsync(
        "/usr/bin/security",
        ["delete-generic-password", "-s", STORAGE_DB_KEY_SERVICE, "-a", account],
        { encoding: "utf8", timeout: 5000, maxBuffer: 4096 },
      );
    } catch (error) {
      if (keychainExitCode(error) !== 44) throw error;
    }
  }

  private async readExisting(): Promise<StorageDatabaseKey | null> {
    const keyHex = await this.readAccount(STORAGE_DB_KEY_ACCOUNT);
    return keyHex ? keyResult(keyHex) : null;
  }

  async get(): Promise<StorageDatabaseKey> {
    const existing = await this.readExisting();
    if (existing) return existing;
    throw new Error(
      "STORAGE_KEY_NOT_FOUND: encrypted metadata key is not present in macOS Keychain.",
    );
  }

  async getOrCreate(): Promise<StorageDatabaseKey> {
    const existing = await this.readExisting();
    if (existing) return existing;

    const keyHex = randomBytes(32).toString("hex");
    try {
      await this.writeAccount(STORAGE_DB_KEY_ACCOUNT, keyHex, false);
      return keyResult(keyHex);
    } catch (error) {
      // A concurrent creator may have won the race. Re-read rather than using
      // `-U`, which could silently overwrite the key protecting an existing DB.
      const raced = await this.readExisting().catch(() => null);
      if (raced) return raced;
      throw new Error(
        "STORAGE_KEY_CREATE_FAILED: could not persist encrypted metadata key in macOS Keychain.",
        { cause: error },
      );
    }
  }

  async prepareRotation(): Promise<StorageKeyRotation> {
    await this.get();
    const rotationId = randomUUID().replaceAll("-", "");
    const accounts = rotationAccounts(rotationId);
    const keyHex = randomBytes(32).toString("hex");
    try {
      await this.writeAccount(accounts.staged, keyHex, false);
    } catch (error) {
      throw new Error(
        "STORAGE_KEY_ROTATION_STAGE_FAILED: could not stage a new metadata key.",
        { cause: error },
      );
    }
    return {
      rotationId,
      next: keyResult(keyHex, `${STORAGE_DB_KEY_SERVICE}:rotation:${rotationId}`),
    };
  }

  async activateRotation(rotation: StorageKeyRotation): Promise<void> {
    const accounts = rotationAccounts(rotation.rotationId);
    const current = await this.get();
    const staged = await this.readAccount(accounts.staged);
    if (!staged || staged !== rotation.next.keyHex) {
      throw new Error(
        "STORAGE_KEY_ROTATION_STAGE_MISSING: staged metadata key is unavailable.",
      );
    }

    await this.deleteAccount(accounts.recovery);
    await this.writeAccount(accounts.recovery, current.keyHex, false);
    try {
      await this.writeAccount(STORAGE_DB_KEY_ACCOUNT, staged, true);
      const activated = await this.get();
      if (activated.keyHex !== staged) {
        throw new Error("STORAGE_KEY_ROTATION_ACTIVATION_VERIFY_FAILED");
      }
    } catch (error) {
      const recovery = await this.readAccount(accounts.recovery).catch(() => null);
      if (recovery) {
        await this.writeAccount(STORAGE_DB_KEY_ACCOUNT, recovery, true).catch(() => undefined);
      }
      throw new Error(
        "STORAGE_KEY_ROTATION_ACTIVATE_FAILED: current Keychain key was not changed safely.",
        { cause: error },
      );
    }
  }

  async finalizeRotation(rotationId: string): Promise<void> {
    const accounts = rotationAccounts(rotationId);
    await this.deleteAccount(accounts.staged);
    await this.deleteAccount(accounts.recovery);
  }

  async rollbackRotation(rotationId: string): Promise<void> {
    const accounts = rotationAccounts(rotationId);
    const recovery = await this.readAccount(accounts.recovery).catch(() => null);
    if (recovery) {
      await this.writeAccount(STORAGE_DB_KEY_ACCOUNT, recovery, true);
    }
    await this.deleteAccount(accounts.staged).catch(() => undefined);
    await this.deleteAccount(accounts.recovery).catch(() => undefined);
  }
}

export function productionStorageKeyProvider(): RotatableStorageKeyProvider {
  return new MacOSKeychainStorageKeyProvider();
}
