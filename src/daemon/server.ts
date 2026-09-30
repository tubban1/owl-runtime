import "dotenv/config";
import express from "express";
import { envFlag } from "../security/capabilities.js";
import { registerRuntimeHttpApi } from "../public/httpRuntimeApi.js";
import { startPersistentScheduler } from "../runtime/scheduler.js";
import { startPersistentLoopController } from "../runtime/loopController.js";
import { startPersistentProcessMonitor } from "../tools/shellOps.js";
import { getRuntimeIdentity } from "../runtime/runtimeIdentity.js";
import {
  runtimeCandidateMode,
  runtimePathStatus,
} from "../runtime/runtimePaths.js";
import { runtimeLifecycle } from "../runtime/runtimeLifecycle.js";
import {
  assertStateSchemaReadable,
  getStateSchemaStatus,
} from "../runtime/stateSchema.js";
import { runtimeSessionManager } from "../runtime/runtimeSessionManager.js";
import { RUNTIME_VERSION } from "../runtime/runtimeVersion.js";
import { RUNTIME_PUBLIC_API_VERSION } from "../public/runtimeClient.js";

const app = express();
app.use(express.json({ limit: "4mb" }));
registerRuntimeHttpApi(app);

const candidateMode = runtimeCandidateMode();
await assertStateSchemaReadable();

if (candidateMode) {
  runtimeLifecycle.requestDrain({
    reason: "candidate_preflight",
    requestedBy: "runtime:candidate",
  });
}

function runtimeHealthLifecycle() {
  const lifecycle = runtimeLifecycle.status();
  return {
    ...lifecycle,
    mutationIdle: lifecycle.activeMutationCount === 0,
  };
}

app.get("/health", async (_req, res) => {
  res.json({
    ok: true,
    service: "owl-runtime",
    version: RUNTIME_VERSION,
    publicApiVersion: RUNTIME_PUBLIC_API_VERSION,
    identity: getRuntimeIdentity(),
    runtime: {
      ...runtimePathStatus(),
      sessions: runtimeSessionManager.summary(),
      lifecycle: runtimeHealthLifecycle(),
      stateSchema: await getStateSchemaStatus(),
      backgroundControllersStarted: !candidateMode,
    },
    capabilities: {
      publicRuntimeApiV01: true,
      executionTargetContract: true,
      diagnosticSupportPackage: true,
      providerPostconditionsV1: true,
      requestCancellation: true,
      processControlCapabilities: true,
      persistentTasks: true,
      persistentScheduler: true,
      persistentLoopController: true,
      primitiveAbi: true,
      observationAbi: true,
      verifierAbi: true,
      managedProcessStateMachine: true,
      approvalReceipts: true,
      executionHealthModel: true,
      skillRuntime: true,
      skillAbi: true,
      resourceArbiter: true,
      sessionAwareConcurrency: true,
      gracefulDrain: true,
      workspaceHandoff: true,
      upgradeCandidateMode: true,
      versionedStateSchema: true,
      stateMigrationRegistry: true,
      crashRecoveryMatrix: true,
      multiAgentSoakHarness: true,
      sameRuntimeDisconnectedSessionReclamation: true,
      sameRuntimeIdleSessionReclamation: true,
      workspaceLeases: true,
      persistentProcessOwnership: true,
      productionRuntimeIsolation: true,
      runtimeSelfProtection: true,
      stateRootIsolation: true,
      crossWorkspaceShellConcurrency: true,
      write: envFlag("ALLOW_WRITE", true),
      delete: envFlag("ALLOW_DELETE", false),
      shell: envFlag("ALLOW_SHELL", false),
      gitPush: envFlag("ALLOW_GIT_PUSH", false),
      rollback: envFlag("ALLOW_ROLLBACK", false),
      browser: envFlag("ALLOW_BROWSER", false),
      gui: envFlag("ALLOW_GUI", false),
      auditLog: envFlag("AUDIT_LOG_ENABLED", true),
    },
  });
});

const port = Number(process.env.PORT ?? 8787);

if (candidateMode) {
  app.listen(port, "127.0.0.1", () => {
    console.log(
      "OWL Runtime candidate preflight mode: background controllers disabled.",
    );
    console.log(
      `OWL Runtime ${RUNTIME_VERSION} daemon candidate listening on http://127.0.0.1:${port}/runtime/v0.1`,
    );
  });
} else {
  const scheduler = startPersistentScheduler();
  const loopController = startPersistentLoopController();
  const processMonitor = startPersistentProcessMonitor();

  app.listen(port, "127.0.0.1", () => {
    console.log(`OWL Runtime scheduler poll=${scheduler.pollMs}ms`);
    console.log(`OWL Runtime loop controller poll=${loopController.pollMs}ms`);
    console.log(`OWL Runtime process monitor poll=${processMonitor.pollMs}ms`);
    console.log(
      `OWL Runtime ${RUNTIME_VERSION} daemon listening on http://127.0.0.1:${port}/runtime/v0.1`,
    );
  });
}
