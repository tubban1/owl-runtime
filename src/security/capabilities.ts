export function envFlag(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export function requireCapability(name: string, defaultValue = false): void {
  if (!envFlag(name, defaultValue)) {
    throw new Error(
      `${name} is disabled. Set ${name}=true in .env and restart computer-mcp to enable it.`,
    );
  }
}
