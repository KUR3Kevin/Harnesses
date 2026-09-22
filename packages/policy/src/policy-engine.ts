import type { ToolDefinition } from "@kur3/contracts";

export type PolicyMode = "plan" | "run";

export type PolicyDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "require_approval"; reason: string };

export interface PolicyContext {
  mode: PolicyMode;
  knownTools: Map<string, ToolDefinition>;
}

/**
 * Tool eligibility: Plan mode allows read + propose_patch only.
 * Run mode allows declared tools including apply_patch.
 * Unknown tools are always denied. Model output cannot elevate permissions.
 */
export function evaluateToolPolicy(
  toolName: string,
  _input: Record<string, unknown>,
  ctx: PolicyContext,
): PolicyDecision {
  const def = ctx.knownTools.get(toolName);
  if (!def) {
    return {
      decision: "deny",
      reason: `Unknown tool "${toolName}" is not registered`,
    };
  }

  if (ctx.mode === "plan") {
    if (def.effect === "write" && toolName !== "propose_patch") {
      return {
        decision: "deny",
        reason: `Plan mode cannot execute write tool "${toolName}"`,
      };
    }
    if (def.effect === "external") {
      return {
        decision: "deny",
        reason: `Plan mode cannot execute external tool "${toolName}"`,
      };
    }
  }

  if (toolName === "run_command") {
    return {
      decision: "deny",
      reason:
        "run_command is disabled until an isolated worker backend is selected (W08)",
    };
  }

  return { decision: "allow" };
}
