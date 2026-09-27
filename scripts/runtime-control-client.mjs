#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

function usage() {
  console.error(
    "Usage: node scripts/runtime-control-client.mjs <mcp-url> <status|drain|wait|resume> [json-args]",
  );
}

const [, , serverUrl, op, jsonArgs = "{}"] = process.argv;
if (!serverUrl || !op) {
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

const client = new Client({
  name: "agentos-runtime-control-client",
  version: "0.1.0",
});
const transport = new StreamableHTTPClientTransport(new URL(serverUrl));

function extractText(result) {
  const textParts = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text);
  if (textParts.length === 0) return result;
  const joined = textParts.join("\n");
  try {
    return JSON.parse(joined);
  } catch {
    return joined;
  }
}

try {
  await client.connect(transport);
  const result = await client.request(
    {
      method: "tools/call",
      params: {
        name: "skill_run",
        arguments: {
          skill: "runtime.control",
          args: {
            op,
            ...extraArgs,
          },
        },
      },
    },
    CallToolResultSchema,
  );

  const extracted = extractText(result);
  const output =
    extracted &&
    typeof extracted === "object" &&
    Object.prototype.hasOwnProperty.call(extracted, "result")
      ? extracted.result
      : extracted;

  if (result.isError) {
    console.error(JSON.stringify(output, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  await transport.close().catch(() => undefined);
}
