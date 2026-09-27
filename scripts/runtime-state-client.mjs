#!/usr/bin/env node

function usage() {
  console.error(
    "Usage: node scripts/runtime-state-client.mjs <runtime-base-url> <status|plan|migrate> [json-args]",
  );
}

const [, , rawBaseUrl, op, jsonArgs = "{}"] = process.argv;
if (!rawBaseUrl || !op) {
  usage();
  process.exit(2);
}

let extraArgs = {};
try {
  extraArgs = JSON.parse(jsonArgs);
} catch (error) {
  console.error(
    `Invalid json-args: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

const baseUrl = rawBaseUrl
  .replace(/\/+$/, "")
  .replace(/\/mcp$/, "");

const headers = {
  "content-type": "application/json",
  "x-owl-session-id": "runtime:upgrade-state",
  "x-owl-request-id": `upgrade-state:${Date.now()}:${process.pid}`,
  ...(process.env.OWL_RUNTIME_API_TOKEN
    ? { authorization: `Bearer ${process.env.OWL_RUNTIME_API_TOKEN}` }
    : {}),
};

try {
  const response = await fetch(`${baseUrl}/runtime/v0.1/rpc`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      method: "skill.run",
      params: {
        skill: "runtime.state",
        args: {
          op,
          ...extraArgs,
        },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    console.error(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
  } else {
    const skillResult = payload.result;
    const output =
      skillResult &&
      typeof skillResult === "object" &&
      Object.prototype.hasOwnProperty.call(skillResult, "result")
        ? skillResult.result
        : skillResult;
    console.log(JSON.stringify(output, null, 2));
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.stack ?? error.message : String(error),
  );
  process.exitCode = 1;
}
