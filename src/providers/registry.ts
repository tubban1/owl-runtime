import { envFlag } from "../security/capabilities.js";
import { configuredRoots, runtimeOwnedRoots } from "../security/pathGuard.js";
import type { ComputerProvider, ProviderStatus } from "./types.js";
import { browserProvider } from "./browserProvider.js";
import { desktopProvider } from "./desktopProvider.js";

class StaticProvider implements ComputerProvider {
  constructor(
    public readonly id: string,
    public readonly label: string,
    private readonly statusFn: () => Promise<ProviderStatus>,
  ) {}

  status(): Promise<ProviderStatus> {
    return this.statusFn();
  }
}

const filesystemProvider = new StaticProvider("filesystem", "Filesystem", async () => ({
  id: "filesystem",
  label: "Filesystem",
  enabled: configuredRoots().length > 0,
  available: configuredRoots().length > 0,
  capabilities: ["filesystem"],
  details: {
    allowedDirectories: configuredRoots(),
    runtimeOwnedDirectories: runtimeOwnedRoots(),
    write: envFlag("ALLOW_WRITE", true),
    delete: envFlag("ALLOW_DELETE", false),
  },
}));

const shellProvider = new StaticProvider("shell", "Shell", async () => ({
  id: "shell",
  label: "Shell",
  enabled: envFlag("ALLOW_SHELL", false),
  available: true,
  capabilities: ["shell"],
  details: { enabledBy: "ALLOW_SHELL" },
}));

const gitProvider = new StaticProvider("git", "Git", async () => ({
  id: "git",
  label: "Git",
  enabled: true,
  available: true,
  capabilities: ["git"],
  details: {
    push: envFlag("ALLOW_GIT_PUSH", false),
  },
}));

const transactionProvider = new StaticProvider("transaction", "Transaction", async () => ({
  id: "transaction",
  label: "Transaction",
  enabled: envFlag("ALLOW_ROLLBACK", false),
  available: true,
  capabilities: ["transaction"],
  details: {
    rollback: envFlag("ALLOW_ROLLBACK", false),
  },
}));

const providers: ComputerProvider[] = [
  filesystemProvider,
  shellProvider,
  gitProvider,
  transactionProvider,
  browserProvider,
  desktopProvider,
];

export async function getProviderStatuses(): Promise<ProviderStatus[]> {
  return await Promise.all(providers.map((provider) => provider.status()));
}
