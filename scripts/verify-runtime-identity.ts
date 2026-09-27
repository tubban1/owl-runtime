import assert from "node:assert/strict";

const {
  getRuntimeIdentity,
  runtimeIdentityDescription,
} = await import("../src/runtime/runtimeIdentity.js");

const previousName = process.env.AGENTOS_NAME;
const previousWake = process.env.AGENTOS_WAKE_NAME;
const previousAliases = process.env.AGENTOS_ALIASES;

try {
  delete process.env.AGENTOS_NAME;
  delete process.env.AGENTOS_WAKE_NAME;
  delete process.env.AGENTOS_ALIASES;

  const defaults = getRuntimeIdentity();
  assert.equal(defaults.productName, "AgentOS Runtime");
  assert.equal(defaults.wakeName, "AgentOS");
  assert.ok(defaults.aliases.includes("AgentOS"));

  process.env.AGENTOS_WAKE_NAME = "Jarvis";
  process.env.AGENTOS_ALIASES = "OWL,Butler";

  const customized = getRuntimeIdentity();
  assert.equal(customized.productName, "AgentOS Runtime");
  assert.equal(customized.wakeName, "Jarvis");
  assert.ok(customized.aliases.includes("Jarvis"));
  assert.ok(customized.aliases.includes("OWL"));
  assert.match(runtimeIdentityDescription(), /Jarvis/);

  console.log(
    JSON.stringify(
      {
        ok: true,
        defaultProductName: defaults.productName,
        defaultWakeName: defaults.wakeName,
        configurableWakeName: customized.wakeName,
        aliases: customized.aliases,
        crossChatCondition: "computer-mcp must be connected in that chat",
      },
      null,
      2,
    ),
  );
} finally {
  if (previousName === undefined) delete process.env.AGENTOS_NAME;
  else process.env.AGENTOS_NAME = previousName;
  if (previousWake === undefined) delete process.env.AGENTOS_WAKE_NAME;
  else process.env.AGENTOS_WAKE_NAME = previousWake;
  if (previousAliases === undefined) delete process.env.AGENTOS_ALIASES;
  else process.env.AGENTOS_ALIASES = previousAliases;
}
