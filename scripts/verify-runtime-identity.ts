import assert from "node:assert/strict";

const {
  getRuntimeIdentity,
  runtimeIdentityDescription,
} = await import("../src/runtime/runtimeIdentity.js");

const keys = [
  "OWL_NAME", "OWL_WAKE_NAME", "OWL_ALIASES",
  "AGENTOS_NAME", "AGENTOS_WAKE_NAME", "AGENTOS_ALIASES",
] as const;
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

try {
  for (const key of keys) delete process.env[key];

  const defaults = getRuntimeIdentity();
  assert.equal(defaults.productName, "OWL Runtime");
  assert.equal(defaults.wakeName, "OWL");
  assert.ok(defaults.aliases.includes("OWL"));
  assert.ok(defaults.aliases.includes("AgentOS"));

  process.env.OWL_WAKE_NAME = "Jarvis";
  process.env.OWL_ALIASES = "Butler";
  const customized = getRuntimeIdentity();
  assert.equal(customized.productName, "OWL Runtime");
  assert.equal(customized.wakeName, "Jarvis");
  assert.ok(customized.aliases.includes("Jarvis"));
  assert.ok(customized.aliases.includes("Butler"));
  assert.match(runtimeIdentityDescription(), /Jarvis/);

  delete process.env.OWL_WAKE_NAME;
  delete process.env.OWL_ALIASES;
  process.env.AGENTOS_NAME = "Legacy AgentOS Runtime";
  process.env.AGENTOS_WAKE_NAME = "LegacyJarvis";
  process.env.AGENTOS_ALIASES = "LegacyAlias";
  const legacy = getRuntimeIdentity();
  assert.equal(legacy.productName, "Legacy AgentOS Runtime");
  assert.equal(legacy.wakeName, "LegacyJarvis");
  assert.ok(legacy.aliases.includes("LegacyAlias"));

  console.log(JSON.stringify({
    ok: true,
    defaultProductName: defaults.productName,
    defaultWakeName: defaults.wakeName,
    canonicalEnv: customized.wakeName,
    legacyEnvFallback: legacy.wakeName,
    aliases: defaults.aliases,
    crossChatCondition: "an OWL Runtime adapter must be connected in that chat",
  }, null, 2));
} finally {
  for (const key of keys) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
