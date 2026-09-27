import { runtimeMode } from "./runtimePaths.js";

function configuredFaults(): Set<string> {
  return new Set(
    (process.env.AGENTOS_FAULT_INJECTION ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function injectTestFault(point: string): void {
  if (runtimeMode() !== "test") return;
  if (!configuredFaults().has(point)) return;
  throw new Error(`AGENTOS_FAULT_INJECTED: ${point}`);
}

export function testFaultEnabled(point: string): boolean {
  return runtimeMode() === "test" && configuredFaults().has(point);
}
