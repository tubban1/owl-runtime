import assert from "node:assert/strict";
import {
  getPrimitiveCatalog,
  PRIMITIVE_ABI_VERSION,
} from "../src/primitives/primitiveRuntime.js";
import { getSkillCatalog } from "../src/skills/skillRuntime.js";

const primitives = new Set(
  getPrimitiveCatalog()
    .filter((entry: any) => entry.canonical === true)
    .map((entry: any) => entry.id),
);

const skills = getSkillCatalog() as any[];
assert.ok(skills.length > 0, "Skill catalog must not be empty.");

for (const skill of skills) {
  assert.equal(typeof skill.skillVersion, "string");
  assert.ok(skill.skillVersion.length > 0);
  assert.ok(Number.isInteger(skill.requiredPrimitiveAbi));
  assert.ok(
    skill.requiredPrimitiveAbi <= PRIMITIVE_ABI_VERSION,
    `${skill.id} requires unsupported Primitive ABI ${skill.requiredPrimitiveAbi}.`,
  );
  assert.ok(Array.isArray(skill.requiredPrimitives));
  for (const primitive of skill.requiredPrimitives) {
    assert.ok(
      primitives.has(primitive),
      `${skill.id} requires unknown Primitive ${primitive}.`,
    );
  }
  assert.ok(
    ["inline", "durable"].includes(skill.executionMode),
    `${skill.id} has invalid executionMode.`,
  );
  assert.deepEqual(Object.keys(skill.memoryPolicy).sort(), [
    "episodic",
    "semanticPromotion",
    "staging",
    "working",
  ]);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      primitiveAbiVersion: PRIMITIVE_ABI_VERSION,
      skills: skills.map((skill) => ({
        id: skill.id,
        skillVersion: skill.skillVersion,
        requiredPrimitiveAbi: skill.requiredPrimitiveAbi,
        requiredPrimitives: skill.requiredPrimitives,
        executionMode: skill.executionMode,
        memoryPolicy: skill.memoryPolicy,
        contract: skill.contract,
      })),
    },
    null,
    2,
  ),
);
