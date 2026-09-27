export type RuntimeIdentity = {
  productName: string;
  wakeName: string;
  aliases: string[];
  invocation: string;
};

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function getRuntimeIdentity(): RuntimeIdentity {
  const productName =
    process.env.AGENTOS_NAME?.trim() || "AgentOS Runtime";
  const wakeName =
    process.env.AGENTOS_WAKE_NAME?.trim() || "AgentOS";
  const configuredAliases =
    process.env.AGENTOS_ALIASES?.split(",").map((value) => value.trim()) ?? [];

  const aliases = unique([
    wakeName,
    productName,
    "AgentOS",
    ...configuredAliases,
  ]);

  return {
    productName,
    wakeName,
    aliases,
    invocation:
      `When computer-mcp is connected, addressing "${wakeName}" or another configured alias means the user is invoking ${productName} and wants the Runtime/tools used for the request when relevant.`,
  };
}

export function runtimeIdentityDescription(): string {
  const identity = getRuntimeIdentity();
  return `${identity.productName} wake name: "${identity.wakeName}". ${identity.invocation}`;
}
