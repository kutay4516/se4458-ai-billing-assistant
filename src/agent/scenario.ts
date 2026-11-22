export type AgentScenario = "mcp-only" | "rest-only" | "combined";

export function scenarioForTrace(trace: Array<{ tool: string }>): AgentScenario {
  const usedMcp = trace.some((entry) => entry.tool === "search_billing_documentation");
  const usedRest = trace.some((entry) => entry.tool !== "search_billing_documentation");
  if (usedMcp && usedRest) return "combined";
  return usedMcp ? "mcp-only" : "rest-only";
}
