import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolDefinition } from "@kur3/contracts";
import { evaluateToolPolicy } from "./policy-engine.js";

function tools(): Map<string, ToolDefinition> {
  const defs: ToolDefinition[] = [
    {
      name: "read_file",
      description: "read",
      inputSchema: {},
      effect: "read",
      timeoutMs: 1000,
      outputLimitBytes: 1000,
      requiredPermissions: [],
      safeRetry: true,
    },
    {
      name: "apply_patch",
      description: "write",
      inputSchema: {},
      effect: "write",
      timeoutMs: 1000,
      outputLimitBytes: 1000,
      requiredPermissions: [],
      safeRetry: false,
    },
    {
      name: "propose_patch",
      description: "propose",
      inputSchema: {},
      effect: "write",
      timeoutMs: 1000,
      outputLimitBytes: 1000,
      requiredPermissions: [],
      safeRetry: true,
    },
    {
      name: "run_command",
      description: "cmd",
      inputSchema: {},
      effect: "external",
      timeoutMs: 1000,
      outputLimitBytes: 1000,
      requiredPermissions: [],
      safeRetry: false,
    },
  ];
  return new Map(defs.map((d) => [d.name, d]));
}

describe("evaluateToolPolicy", () => {
  it("denies unknown tools", () => {
    const r = evaluateToolPolicy("boom", {}, { mode: "run", knownTools: tools() });
    assert.equal(r.decision, "deny");
  });

  it("plan mode denies apply_patch", () => {
    const r = evaluateToolPolicy(
      "apply_patch",
      { path: "a.ts" },
      { mode: "plan", knownTools: tools() },
    );
    assert.equal(r.decision, "deny");
  });

  it("plan mode allows propose_patch", () => {
    const r = evaluateToolPolicy(
      "propose_patch",
      { path: "a.ts" },
      { mode: "plan", knownTools: tools() },
    );
    assert.equal(r.decision, "allow");
  });

  it("run mode allows apply_patch", () => {
    const r = evaluateToolPolicy(
      "apply_patch",
      { path: "a.ts" },
      { mode: "run", knownTools: tools() },
    );
    assert.equal(r.decision, "allow");
  });

  it("plan mode denies run_command even when worker enabled", () => {
    const r = evaluateToolPolicy(
      "run_command",
      { argv: ["echo", "hi"] },
      { mode: "plan", knownTools: tools(), commandWorkerEnabled: true },
    );
    assert.equal(r.decision, "deny");
    if (r.decision === "deny") assert.match(r.reason, /Plan mode/);
  });

  it("run mode denies run_command when worker not enabled", () => {
    const r = evaluateToolPolicy(
      "run_command",
      { argv: ["echo", "hi"] },
      { mode: "run", knownTools: tools(), commandWorkerEnabled: false },
    );
    assert.equal(r.decision, "deny");
    if (r.decision === "deny") assert.match(r.reason, /isolated command worker/);
  });

  it("run mode allows run_command when isolated worker enabled", () => {
    const r = evaluateToolPolicy(
      "run_command",
      { argv: ["echo", "hi"] },
      { mode: "run", knownTools: tools(), commandWorkerEnabled: true },
    );
    assert.equal(r.decision, "allow");
  });
});
