import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const STORAGE_DB_KEY_SERVICE = "fan.fde.owl.runtime.storage-metadata";
export const STORAGE_DB_KEY_ACCOUNT = "default";

export type StorageDatabaseKey = { keyId: string; version: 1; keyHex: string };
export interface StorageKeyProvider { getOrCreate(): Promise<StorageDatabaseKey>; get(): Promise<StorageDatabaseKey>; }

function validateKeyHex(value: string): string {
  const key = value.trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("STORAGE_KEY_INVALID: expected a 256-bit lowercase hex key.");
  return key;
}

export class MacOSKeychainStorageKeyProvider implements StorageKeyProvider {
  async get(): Promise<StorageDatabaseKey> {
    if (process.platform !== "darwin") throw new Error("STORAGE_KEY_PROVIDER_UNAVAILABLE: macOS Keychain provider requires darwin.");
    try {
      const { stdout } = await execFileAsync("/usr/bin/security", ["find-generic-password", "-s", STORAGE_DB_KEY_SERVICE, "-a", STORAGE_DB_KEY_ACCOUNT, "-w"], { encoding: "utf8", timeout: 5000, maxBuffer: 4096 });
      return { keyId: `${STORAGE_DB_KEY_SERVICE}:v1`, version: 1, keyHex: validateKeyHex(stdout) };
    } catch (error) {
      throw new Error("STORAGE_KEY_UNAVAILABLE: encrypted metadata key is not available from macOS Keychain.", { cause: error });
    }
  }

  async getOrCreate(): Promise<StorageDatabaseKey> {
    try { return await this.get(); } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("STORAGE_KEY_UNAVAILABLE:")) throw error;
    }
    const keyHex = randomBytes(32).toString("hex");
    try {
      await execFileAsync("/usr/bin/security", ["add-generic-password", "-U", "-s", STORAGE_DB_KEY_SERVICE, "-a", STORAGE_DB_KEY_ACCOUNT, "-w", keyHex], { encoding: "utf8", timeout: 5000, maxBuffer: 4096 });
    } catch (error) {
      throw new Error("STORAGE_KEY_CREATE_FAILED: could not persist encrypted metadata key in macOS Keychain.", { cause: error });
    }
    return { keyId: `${STORAGE_DB_KEY_SERVICE}:v1`, version: 1, keyHex };
  }
}

export function productionStorageKeyProvider(): StorageKeyProvider {
  return new MacOSKeychainStorageKeyProvider();
}
