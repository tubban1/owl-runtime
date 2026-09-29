import path from "node:path";

process.env.OWL_RUNTIME_MODE = "test";

const scratch = process.env.PUBLIC_EVENT_CONCURRENT_SCRATCH;
if (!scratch) throw new Error("PUBLIC_EVENT_CONCURRENT_SCRATCH is required.");

process.env.RUNTIME_PUBLIC_EVENT_DIR = path.join(scratch, "events");
process.env.RUNTIME_PUBLIC_EVENT_KEY_PATH = path.join(scratch, "events.key");
process.env.RUNTIME_PUBLIC_EVENT_RETENTION_MAX = "10000";

const prefix = process.argv[2];
const count = Number.parseInt(process.argv[3] || "0", 10);
if (!prefix || !Number.isSafeInteger(count) || count < 1 || count > 100) {
  throw new Error("usage: worker <prefix> <count>");
}

const { appendPublicRuntimeEvent } = await import(
  "../src/runtime/publicEventJournal.js"
);

for (let index = 0; index < count; index += 1) {
  await appendPublicRuntimeEvent({
    eventType: "agent_request.proposed",
    eventId: "evt_concurrent_" + prefix + "_" + index,
    proposalId: "proposal_concurrent_" + prefix + "_" + index,
    requestType: "skill.repair",
    priority: "normal",
    subject: {
      kind: "skill_candidate",
      id: "candidate_concurrent_" + prefix,
      revision: String(index + 1),
    },
    reasonCode: "VALIDATION_FAILED",
    errorCodes: ["SEMANTIC_REPAIR_REQUIRED"],
    contextRefs: [],
    allowedActions: ["candidate.inspect"],
    requiresUserConfirmation: true,
    dedupeKey: "runtime:concurrent:" + prefix + ":" + index,
    occurredAt: new Date(1_800_000_000_000 + index).toISOString(),
  });
}

console.log("APPEND_PASS " + prefix + " " + count);
