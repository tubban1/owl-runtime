#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath =
  process.env.SOAK_REPORT_PATH?.trim() ||
  path.join(
    process.env.SOAK_REPORT_DIR?.trim() || path.join(root, ".soak-results"),
    "latest.json",
  );

try {
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  const metrics = report.metrics ?? {};
  const state = report.runtimeState ?? {};
  console.log(
    [
      `AgentOS soak: ${report.status ?? "unknown"}`,
      `  run:       ${report.runId ?? "unknown"}`,
      `  profile:   ${report.profile ?? "unknown"}`,
      `  elapsed:   ${Math.round((report.elapsedMs ?? 0) / 1000)}s`,
      `  remaining: ${Math.round((report.remainingMs ?? 0) / 1000)}s`,
      `  heartbeat: ${report.heartbeatAt ?? "unknown"}`,
      `  iterations: ${metrics.foregroundIterations ?? 0}`,
      `  p95 wait:   ${metrics.p95ResourceWaitMs ?? 0}ms`,
      `  max lag:    ${metrics.eventLoopLagMaxMs ?? 0}ms`,
      `  tasks:      ${state.taskCount ?? report.counts?.taskCount ?? 0}`,
      `  processes:  ${state.runningProcessCount ?? 0} running`,
      `  leases:     ${state.workspaceLeaseCount ?? report.counts?.workspaceLeaseCount ?? 0}`,
      `  adapters:   ${metrics.adapterRuns?.length ?? 0}`,
      `  errors:     ${report.finalErrors?.length ?? metrics.errors?.length ?? 0}`,
      `  report:     ${reportPath}`,
    ].join("\n"),
  );
} catch (error) {
  console.error(
    `No readable soak report at ${reportPath}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
}
