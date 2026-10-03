import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import type {
  ModelProvider,
  ProviderCapabilities,
  ProviderRequest,
  Run,
  StreamEvent,
  ToolCall,
} from "@kur3/contracts";
import { RunStore } from "@kur3/storage";
import { FileWorker, contentHash } from "@kur3/worker";
import {
  assessReservation,
  formatSpend,
  freshBudget,
  quoteReservation,
  settleDanglingReservation,
} from "./budget.js";
import { buildHandoff } from "./handoff.js";
import { planRecoveryAction, reconcileToolCall } from "./recovery.js";
import { HarnessRuntime } from "./runtime.js";

const PRE = 'export function hello(): string {\n  return "hello";\n}\n';
const POST = 'export function hello(): string {\n  return "hello, kur3";\n}\n';

function limits(extra: Record<string, unknown> = {}) {
  return {
    maxToolSteps: 30,
    maxDurationMs: 900_000,
    maxCommandMs: 60_000,
    maxTransientRetries: 2,
    maxIdenticalFailures: 3,
    ...extra,
  };
}

function seedRun(store: RunStore, id: string, state: Run["state"], extra: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return store.createRun({
    id,
    taskId: "task",
    providerId: "fake",
    modelId: "fake-v1",
    state,
    limits: limits(),
    createdAt: now,
    updatedAt: now,
    toolStepsUsed: 0,
    lastEventSequence: 0,
    ...extra,
  });
}

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  calls = 0;
  constructor(
    private readonly events: StreamEvent[],
    private readonly onStream?: () => void,
  ) {}
  capabilities(): ProviderCapabilities {
    return {
      nativeTools: true,
      structuredOutput: false,
      streaming: true,
      reasoningControls: false,
    };
  }
  async *stream(
    _request: ProviderRequest,
    _abort?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    this.calls += 1;
    this.onStream?.();
    for (const ev of this.events) yield ev;
  }
}

describe("budget reservations", () => {
  it("does not treat an unknown quote as zero", () => {
    const budget = freshBudget(1_000_000, "fixture");
    const quote = quoteReservation({
      estimatedInputTokens: 10,
      maxOutputTokens: 100,
      prices: undefined,
    });
    assert.equal(quote.label, "unknown");
    assert.equal(quote.usd, undefined);
    const decision = assessReservation({
      limitUsd: 1_000_000,
      budget,
      quote,
    });
    assert.equal(decision.ok, false);
  });

  it("blocks when the reservation exceeds remaining", () => {
    const budget = freshBudget(0.01, "fixture");
    const quote = quoteReservation({
      estimatedInputTokens: 100,
      maxOutputTokens: 1_000,
      prices: { inputUsdPer1k: 1, outputUsdPer1k: 1 },
    });
    assert.equal(quote.label, "usd");
    const decision = assessReservation({ limitUsd: 0.01, budget, quote });
    assert.equal(decision.ok, false);
  });

  it("keeps a dangling reservation as unknown instead of refunding it", () => {
    const settled = settleDanglingReservation({
      ...freshBudget(1, "fixture"),
      reservedUsd: 1,
    });
    assert.equal(settled.reservedUsd, 0);
    assert.equal(settled.unknownHeldUsd, 1);
    assert.equal(formatSpend(settled, 1), "unknown");
    assert.notEqual(formatSpend(settled, 1), "0.000000");
    const quote = quoteReservation({
      estimatedInputTokens: 4,
      maxOutputTokens: 10,
      prices: { inputUsdPer1k: 1, outputUsdPer1k: 1 },
    });
    const decision = assessReservation({ limitUsd: 1, budget: settled, quote });
    assert.equal(decision.ok, false);
  });
});

describe("recovery planner", () => {
  const base: ToolCall = {
    id: "c",
    runId: "r",
    name: "apply_patch",
    input: { path: "src/hello.ts" },
    inputDigest: "d",
    policyDecision: "allow",
    lifecycle: "outcome_unknown",
    effect: "write",
    mutates: true,
    safeRetry: false,
    expectedPreHash: "pre",
    expectedPostHash: "post",
  };

  it("skips a write when the post-hash is already on disk", () => {
    assert.equal(planRecoveryAction(base, "post"), "already_applied_skip_write");
  });

  it("retries once only when the pre-hash is still current", () => {
    assert.equal(planRecoveryAction(base, "pre"), "retry_write_once");
  });

  it("does not overwrite a conflicting file", () => {
    assert.equal(planRecoveryAction(base, "other"), "conflict_skip_write");
  });

  it("never auto-retries an external mutation", async () => {
    let executes = 0;
    const call: ToolCall = {
      ...base,
      name: "run_command",
      effect: "external",
      mutates: true,
      input: { argv: ["echo", "hi"] },
    };
    const result = await reconcileToolCall(call, {
      inspectHash: () => "unused",
      execute: async () => {
        executes += 1;
        return { status: "ok" };
      },
    });
    assert.equal(executes, 0);
    assert.equal(result.step.action, "unsafe_no_retry");
    assert.equal(result.step.wrote, false);
    assert.equal(result.call.lifecycle, "outcome_unknown");
  });

  it("retries a read only when safeRetry is declared", async () => {
    let reads = 0;
    const safe = await reconcileToolCall(
      {
        ...base,
        name: "read_file",
        effect: "read",
        mutates: false,
        safeRetry: true,
      },
      {
        inspectHash: () => undefined,
        execute: async () => {
          reads += 1;
          return { status: "ok" };
        },
      },
    );
    assert.equal(reads, 1);
    assert.equal(safe.step.action, "retry_safe_readonly");

    let unsafeReads = 0;
    const unsafe = await reconcileToolCall(
      {
        ...base,
        name: "read_file",
        effect: "read",
        mutates: false,
        safeRetry: false,
      },
      {
        inspectHash: () => undefined,
        execute: async () => {
          unsafeReads += 1;
          return { status: "ok" };
        },
      },
    );
    assert.equal(unsafeReads, 0);
    assert.equal(unsafe.step.action, "unsafe_no_retry");
  });
});

describe("W09 runtime fixtures", () => {
  let workspace: string;
  let dataDir: string;
  let writes: number;
  let originalApply: FileWorker["applyPatch"];

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kur3-w09-ws-"));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kur3-w09-data-"));
    fs.mkdirSync(path.join(workspace, "src"));
    writes = 0;
    originalApply = FileWorker.prototype.applyPatch;
    FileWorker.prototype.applyPatch = function (this: FileWorker, ...args) {
      writes += 1;
      return originalApply.apply(this, args);
    };
  });

  afterEach(() => {
    FileWorker.prototype.applyPatch = originalApply;
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function patchCall(id: string): ToolCall {
    return {
      id,
      runId: "run-crash",
      name: "apply_patch",
      input: {
        path: "src/hello.ts",
        expectedHash: contentHash(PRE),
        newContent: POST,
      },
      inputDigest: "digest",
      policyDecision: "allow",
      lifecycle: "running",
      effect: "write",
      mutates: true,
      safeRetry: false,
      expectedPreHash: contentHash(PRE),
      expectedPostHash: contentHash(POST),
    };
  }

  async function resumeCrash(): Promise<{
    runtime: HarnessRuntime;
    actions: Awaited<ReturnType<HarnessRuntime["resumeRun"]>>["actions"];
  }> {
    const setup = new RunStore(dataDir);
    seedRun(setup, "run-crash", "running");
    setup.upsertToolCall(patchCall("call-1"));
    setup.acquireLease("run-crash", "dead-holder", -1);
    const runtime = new HarnessRuntime({
      workspaceRoot: workspace,
      dataDir,
      provider: new ScriptedProvider([
        { type: "text_delta", text: "should-not-run" },
        { type: "completed", finishReason: "stop" },
      ]),
      holderId: "recovery-holder",
    });
    const result = await runtime.resumeRun("run-crash");
    assert.equal(result.ok, true);
    assert.equal(result.continued, false);
    return { runtime, actions: result.actions };
  }

  it("A11 already applied: reconciles post-hash and does not write again", async () => {
    fs.writeFileSync(path.join(workspace, "src", "hello.ts"), POST);
    const before = fs.readFileSync(path.join(workspace, "src", "hello.ts"));
    const { actions } = await resumeCrash();
    const after = fs.readFileSync(path.join(workspace, "src", "hello.ts"));
    assert.equal(writes, 0);
    assert.deepEqual(after, before);
    assert.equal(actions[0]?.action, "already_applied_skip_write");
    assert.equal(actions[0]?.wrote, false);
    const again = await new HarnessRuntime({
      workspaceRoot: workspace,
      dataDir,
      provider: new ScriptedProvider([]),
      holderId: "second",
    }).resumeRun("run-crash");
    assert.equal(writes, 0);
    assert.equal(again.actions[0]?.action, "terminal_unchanged");
  });

  it("A11 not applied: retries the write once, then does not repeat it", async () => {
    fs.writeFileSync(path.join(workspace, "src", "hello.ts"), PRE);
    const { actions } = await resumeCrash();
    assert.equal(writes, 1);
    assert.equal(actions[0]?.action, "retry_write_once");
    assert.equal(actions[0]?.wrote, true);
    assert.equal(
      fs.readFileSync(path.join(workspace, "src", "hello.ts"), "utf8"),
      POST,
    );
    writes = 0;
    const again = await new HarnessRuntime({
      workspaceRoot: workspace,
      dataDir,
      provider: new ScriptedProvider([]),
      holderId: "second",
    }).resumeRun("run-crash");
    assert.equal(writes, 0);
    assert.equal(again.actions[0]?.action, "terminal_unchanged");
    assert.equal(
      fs.readFileSync(path.join(workspace, "src", "hello.ts"), "utf8"),
      POST,
    );
  });

  it("A11 conflict: does not overwrite unexpected content", async () => {
    const other = "someone else edited this\n";
    fs.writeFileSync(path.join(workspace, "src", "hello.ts"), other);
    const { actions } = await resumeCrash();
    assert.equal(writes, 0);
    assert.equal(actions[0]?.action, "conflict_skip_write");
    assert.equal(
      fs.readFileSync(path.join(workspace, "src", "hello.ts"), "utf8"),
      other,
    );
  });

  it("A12 only one runtime can hold the active lease", async () => {
    const first = new HarnessRuntime({
      workspaceRoot: workspace,
      dataDir,
      provider: new ScriptedProvider([]),
      holderId: "holder-a",
    });
    const second = new HarnessRuntime({
      workspaceRoot: workspace,
      dataDir,
      provider: new ScriptedProvider([]),
      holderId: "holder-b",
    });
    const now = new Date().toISOString();
    first.getStore().createRun({
      id: "leased",
      taskId: "t",
      providerId: "scripted",
      modelId: "m",
      state: "paused",
      limits: limits(),
      createdAt: now,
      updatedAt: now,
      toolStepsUsed: 0,
      lastEventSequence: 0,
    });
    const held = first.getStore().acquireLease("leased", "holder-a");
    assert.equal(held.ok, true);
    const resumed = await second.resumeRun("leased");
    assert.equal(resumed.ok, false);
    assert.match(resumed.reason ?? "", /lease/i);
    assert.equal(resumed.continued, false);
    const still = first.getStore().acquireLease("leased", "holder-a");
    assert.equal(still.ok, true);
  });

  it("A13 refuses a request the reservation cannot cover, before streaming", async () => {
    const provider = new ScriptedProvider([
      { type: "text_delta", text: "nope" },
      { type: "completed", finishReason: "stop" },
    ]);
    const runtime = new HarnessRuntime({
      workspaceRoot: workspace,
      dataDir,
      provider,
      prices: {
        priceVersion: "fixture-2026-10-02",
        inputUsdPer1k: 1,
        outputUsdPer1k: 1,
      },
    });
    const result = await runtime.startRun({
      task: {
        id: "budget-task",
        projectId: "p",
        goal: "do not spend",
        scope: [],
        mode: "run",
        acceptanceCriteria: [],
      },
      limits: { estimatedSpendingLimitUsd: 0.01, maxOutputTokens: 1_000 },
    });
    assert.equal(provider.calls, 0);
    assert.equal(result.run.state, "budget_exhausted");
    assert.equal(result.run.budget?.reservedUsd ?? 0, 0);
    const events = runtime.getStore().listEvents(result.run.id);
    assert.ok(events.some((e) => e.type === "error" && e.payload.code === "budget_exhausted"));
    assert.equal(
      events.some((e) => e.payload.estimatedCostUsd === 0),
      false,
    );
  });

  it("A13 reserves before the request and blocks the next one after real usage", async () => {
    let reservedDuringStream = -1;
    const provider = new ScriptedProvider(
      [
        {
          type: "tool_request",
          callId: "read-1",
          name: "read_file",
          input: { path: "src/hello.ts" },
        },
        { type: "usage", inputTokens: 20_000, outputTokens: 20_000 },
        { type: "completed", finishReason: "tool_calls" },
      ],
      () => {
        const raw = JSON.parse(
          fs.readFileSync(path.join(dataDir, "store.json"), "utf8"),
        ) as { runs: Record<string, { budget?: { reservedUsd?: number } }> };
        const run = Object.values(raw.runs)[0];
        reservedDuringStream = run?.budget?.reservedUsd ?? -1;
      },
    );
    fs.writeFileSync(path.join(workspace, "src", "hello.ts"), PRE);
    const runtime = new HarnessRuntime({
      workspaceRoot: workspace,
      dataDir,
      provider,
      prices: {
        priceVersion: "fixture-2026-10-02",
        inputUsdPer1k: 1,
        outputUsdPer1k: 1,
      },
    });
    const result = await runtime.startRun({
      task: {
        id: "budget-task",
        projectId: "p",
        goal: "read then stop",
        scope: ["src/hello.ts"],
        mode: "run",
        acceptanceCriteria: [],
      },
      limits: { estimatedSpendingLimitUsd: 5, maxOutputTokens: 100 },
    });
    assert.ok(reservedDuringStream > 0, "reservation must be durable before streaming");
    assert.equal(provider.calls, 1);
    assert.equal(result.run.state, "budget_exhausted");
    assert.ok((result.run.budget?.spentKnownUsd ?? 0) > 5);
    const note = runtime
      .getStore()
      .listEvents(result.run.id)
      .find((e) => e.type === "budget_reserved");
    assert.equal(
      note?.payload.note,
      "estimated spending limit, not a guaranteed provider billing cap",
    );
  });

  it("A13 labels missing usage unknown and never zero", async () => {
    const provider = new ScriptedProvider([
      { type: "text_delta", text: "done" },
      { type: "completed", finishReason: "stop" },
    ]);
    const runtime = new HarnessRuntime({
      workspaceRoot: workspace,
      dataDir,
      provider,
      prices: {
        priceVersion: "fixture-2026-10-02",
        inputUsdPer1k: 0.5,
        outputUsdPer1k: 0.5,
      },
    });
    const result = await runtime.startRun({
      task: {
        id: "unknown-usage",
        projectId: "p",
        goal: "finish without usage",
        scope: [],
        mode: "run",
        acceptanceCriteria: [],
      },
      limits: { estimatedSpendingLimitUsd: 100, maxOutputTokens: 100 },
    });
    assert.equal(provider.calls, 1);
    assert.equal(result.run.budget?.costLabel, "unknown");
    assert.equal(formatSpend(result.run.budget, 100), "unknown");
    assert.ok((result.run.budget?.unknownHeldUsd ?? 0) > 0);
    const events = runtime.getStore().listEvents(result.run.id);
    assert.equal(
      events.some((e) => e.payload.estimatedCostUsd === 0),
      false,
    );
    const reconciled = events.find((e) => e.type === "budget_reconciled");
    assert.equal(reconciled?.payload.costLabel, "unknown");
    assert.equal("estimatedCostUsd" in (reconciled?.payload ?? {}), false);
  });

  it("A13 unknown prices do not authorize a call under a spending limit", async () => {
    const provider = new ScriptedProvider([
      { type: "text_delta", text: "no" },
      { type: "completed", finishReason: "stop" },
    ]);
    const runtime = new HarnessRuntime({
      workspaceRoot: workspace,
      dataDir,
      provider,
    });
    const result = await runtime.startRun({
      task: {
        id: "no-price",
        projectId: "p",
        goal: "blocked",
        scope: [],
        mode: "run",
        acceptanceCriteria: [],
      },
      limits: { estimatedSpendingLimitUsd: 1_000_000, maxOutputTokens: 50 },
    });
    assert.equal(provider.calls, 0);
    assert.equal(result.run.state, "budget_exhausted");
  });

  it("explicit limit raise is required before billable resume", async () => {
    const provider = new ScriptedProvider([
      { type: "text_delta", text: "after raise" },
      { type: "completed", finishReason: "stop" },
    ]);
    const prices = {
      priceVersion: "fixture-2026-10-02",
      inputUsdPer1k: 0.01,
      outputUsdPer1k: 0.01,
    };
    const runtime = new HarnessRuntime({
      workspaceRoot: workspace,
      dataDir,
      provider,
      prices,
      holderId: "budget-holder",
    });
    const blocked = await runtime.startRun({
      task: {
        id: "raise-task",
        projectId: "p",
        goal: "wait for a higher estimate",
        scope: [],
        mode: "run",
        acceptanceCriteria: [],
      },
      limits: { estimatedSpendingLimitUsd: 0.00001, maxOutputTokens: 10_000 },
    });
    assert.equal(provider.calls, 0);
    assert.equal(blocked.run.state, "budget_exhausted");

    const resumed = await new HarnessRuntime({
      workspaceRoot: workspace,
      dataDir,
      provider,
      prices,
      holderId: "resume-holder",
    }).resumeRun(blocked.run.id);
    assert.equal(provider.calls, 0);
    assert.equal(resumed.continued, false);
    assert.equal(resumed.run?.state, "budget_exhausted");

    const raiser = new HarnessRuntime({
      workspaceRoot: workspace,
      dataDir,
      provider,
      prices,
      holderId: "raise-holder",
    });
    raiser.raiseEstimatedSpendingLimit(blocked.run.id, 100);
    const continued = await raiser.resumeRun(blocked.run.id);
    assert.equal(provider.calls, 1);
    assert.equal(continued.continued, true);
    assert.equal(continued.run?.state, "completed");
  });

  it("export_handoff redacts secrets and does not present unknown spend as zero", async () => {
    const store = new RunStore(dataDir);
    const now = new Date().toISOString();
    const run = store.createRun({
      id: "handoff-run",
      taskId: "t",
      providerId: "fake",
      modelId: "m",
      state: "paused",
      limits: limits({ estimatedSpendingLimitUsd: 2, maxOutputTokens: 100 }),
      createdAt: now,
      updatedAt: now,
      toolStepsUsed: 1,
      lastEventSequence: 0,
      budget: {
        ...freshBudget(2, "fixture-2026-10-02"),
        unknownHeldUsd: 0.2,
        unknownChargeCount: 1,
        costLabel: "unknown",
      },
    });
    store.saveCheckpoint({
      runId: run.id,
      runState: "paused",
      lastEventSequence: 0,
      taskFacts: {
        goal: "use key sk-test-SECRETVALUE please",
        mode: "run",
        scope: ["src/hello.ts"],
        decisions: [{ summary: "kept the patch", reason: "hash matched" }],
        apiKey: "sk-test-SECRETVALUE",
      },
      pendingCalls: ["call-x"],
      savedAt: now,
    });
    store.appendEvent("handoff-run", "tool_finished", {
      callId: "call-x",
      result: {
        status: "applied",
        path: "src/hello.ts",
        newHash: contentHash(POST),
        newContent: "secret sk-test-SECRETVALUE",
      },
    });
    store.appendEvent("handoff-run", "verification_recorded", {
      criterionId: "ac",
      description: "check",
      outcome: "failed",
      evidence: "token=sk-test-SECRETVALUE",
    });
    const runtime = new HarnessRuntime({
      workspaceRoot: workspace,
      dataDir,
      provider: new ScriptedProvider([]),
      repositoryRevision: "abc123",
    });
    const handoff = runtime.exportHandoff("handoff-run");
    const encoded = JSON.stringify(handoff);
    assert.equal(encoded.includes("SECRETVALUE"), false);
    assert.equal(encoded.includes("sk-test"), false);
    assert.match(encoded, /\[REDACTED\]/);
    assert.equal(handoff.redacted, true);
    assert.equal(handoff.budget.spendDisplay, "unknown");
    assert.notEqual(handoff.budget.spendDisplay, "0");
    assert.notEqual(handoff.budget.spendDisplay, "0.000000");
    assert.equal(
      handoff.budget.note,
      "estimated spending limit, not a guaranteed provider billing cap",
    );
    assert.equal(handoff.artifacts[0]?.path, "src/hello.ts");
    assert.equal(handoff.artifacts[0]?.contentHash, contentHash(POST));
    assert.equal(JSON.stringify(handoff.artifacts).includes("newContent"), false);
    assert.equal(handoff.repositoryRevision, "abc123");
    assert.ok(handoff.remainingWork.length > 0);
    const rebuilt = buildHandoff({
      run,
      events: store.listEvents(run.id),
      checkpoint: store.getCheckpoint(run.id),
    });
    assert.equal(JSON.stringify(rebuilt).includes("SECRETVALUE"), false);
  });
});
