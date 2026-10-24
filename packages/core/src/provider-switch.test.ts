import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Checkpoint, Event, Run, ToolCall } from "@kur3/contracts";
import { PortableCheckpointSchema } from "@kur3/contracts";
import {
  AnthropicMessagesProvider,
  FakeProvider,
  OpenAICompatibleProvider,
} from "@kur3/providers";
import { freshBudget } from "./budget.js";
import { switchProvider, toPortableCheckpoint, verifyPortableCheckpoint } from "./provider-switch.js";

const NOW = "2026-10-10T11:00:00.000Z";
const OPAQUE = ["OPAQUE-THINKING-SIG", "resp_opaque_123", "cache-handle-xyz", "SECRET-REASONING"];

function run(extra: Partial<Run> = {}): Run {
  return {
    id: "r1",
    taskId: "t1",
    providerId: "openai-compatible",
    modelId: "gpt-x",
    state: "paused",
    limits: {
      maxToolSteps: 30,
      maxDurationMs: 900_000,
      maxCommandMs: 60_000,
      maxTransientRetries: 2,
      maxIdenticalFailures: 3,
      estimatedSpendingLimitUsd: 5,
    },
    createdAt: NOW,
    updatedAt: NOW,
    toolStepsUsed: 2,
    lastEventSequence: 9,
    budget: { ...freshBudget(5), spentKnownUsd: 0.42 },
    ...extra,
  };
}

function ev(sequence: number, type: Event["type"], payload: Record<string, unknown>): Event {
  return { schemaVersion: "0.1.0", id: `e${sequence}`, runId: "r1", sequence, type, timestamp: NOW, payload };
}

const EVENTS: Event[] = [
  ev(4, "tool_finished", {
    callId: "c-apply",
    result: { status: "applied", path: "src/hello.ts", newHash: "sha256:post" },
  }),
  ev(7, "verification_recorded", {
    criterionId: "AC1",
    description: "tests pass",
    outcome: "passed",
    evidence: "npm test: 12 passed, 0 failed",
    exitStatus: 0,
  }),
];

function checkpoint(extra: Partial<Checkpoint> = {}): Checkpoint {
  return {
    runId: "r1",
    runState: "paused",
    lastEventSequence: 9,
    taskFacts: {
      taskId: "t1",
      goal: "Make hello() greet kur3",
      mode: "run",
      scope: ["src/hello.ts"],
      acceptanceCriteria: [{ id: "AC1", description: "tests pass" }],
      decisions: [{ summary: "Edit in place", reason: "single call site" }],
      startedAtMs: 1,
      // Opaque provider state that must never cross a switch:
      providerState: { previous_response_id: "resp_opaque_123" },
      promptCache: "cache-handle-xyz",
      transcript: [
        { role: "user", content: "Make hello() greet kur3" },
        { role: "assistant", content: "Patching.", reasoning_signature: "OPAQUE-THINKING-SIG" },
        { role: "tool", content: "applied", toolCallId: "c-apply", name: "apply_patch" },
        { role: "thinking", content: "SECRET-REASONING" },
        { type: "redacted_thinking", data: "OPAQUE-THINKING-SIG" },
      ],
    },
    pendingCalls: [],
    workspaceRevision: "git:abc1234",
    savedAt: NOW,
    ...extra,
  };
}

/** Ledger that agrees with EVENTS (c-apply finished). */
const LEDGER: ToolCall[] = [
  {
    id: "c-apply",
    runId: "r1",
    name: "apply_patch",
    input: { path: "src/hello.ts" },
    inputDigest: "d",
    policyDecision: "allow",
    lifecycle: "succeeded",
  },
];

function anthropic(seen: { body?: string }) {
  return new AnthropicMessagesProvider({
    baseUrl: "https://example.test/v1",
    apiKey: "sk-ant-test-not-real",
    fetch: async (_u, init) => {
      seen.body = String(init?.body);
      return new Response(
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"continuing"}}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        { status: 200 },
      );
    },
  });
}

describe("W10 provider switch", () => {
  it("A15: goal, decisions, artifacts and checks survive a provider change", async () => {
    const seen: { body?: string } = {};
    const to = anthropic(seen);
    const res = switchProvider({ toolCalls: LEDGER,
      run: run(),
      checkpoint: checkpoint(),
      events: EVENTS,
      to,
      toModelId: "claude-x",
      now: () => NOW,
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    PortableCheckpointSchema.parse(res.portable);
    assert.equal(res.run.providerId, "anthropic-messages");
    assert.equal(res.run.modelId, "claude-x");
    assert.equal(res.run.id, "r1");
    const facts = res.checkpoint.taskFacts;
    assert.equal(facts.goal, "Make hello() greet kur3");
    assert.deepEqual(facts.decisions, [{ summary: "Edit in place", reason: "single call site" }]);
    assert.deepEqual(res.portable.handoff.artifacts.map((a) => [a.path, a.contentHash]), [["src/hello.ts", "sha256:post"]]);
    assert.equal(res.portable.handoff.verifications[0]!.evidence, "npm test: 12 passed, 0 failed");
    assert.equal(res.portable.handoff.repositoryRevision, "git:abc1234");
    assert.deepEqual((facts.providerSwitches as unknown[]).length, 1);

    // Actually send to the new adapter (mocked) and check the wire request.
    const out: string[] = [];
    for await (const e of to.stream({ modelId: "claude-x", messages: res.messages })) {
      if (e.type === "text_delta") out.push(e.text);
    }
    assert.equal(out.join(""), "continuing");
    const body = JSON.parse(seen.body!);
    for (const needle of [
      "Goal: Make hello() greet kur3",
      "Decision: Edit in place — because single call site",
      "Artifact: src/hello.ts @ sha256:post",
      "Check AC1: passed — npm test: 12 passed, 0 failed",
      "Repository revision: git:abc1234",
      "Next action:",
    ]) {
      assert.ok(String(body.system).includes(needle), `system missing ${needle}`);
    }
  });

  it("switch back the other way keeps the same facts (round trip)", () => {
    const first = switchProvider({ toolCalls: LEDGER, run: run(), checkpoint: checkpoint(), events: EVENTS, to: anthropic({}), toModelId: "claude-x", now: () => NOW });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const back = switchProvider({ toolCalls: LEDGER,
      run: first.run,
      checkpoint: first.checkpoint,
      events: EVENTS,
      to: new OpenAICompatibleProvider({ baseUrl: "https://example.test/v1", apiKey: "sk-test-not-real", fetch: async () => new Response("") }),
      toModelId: "gpt-x",
      now: () => NOW,
    });
    assert.equal(back.ok, true);
    if (!back.ok) return;
    assert.equal(back.checkpoint.taskFacts.goal, first.checkpoint.taskFacts.goal);
    assert.deepEqual(back.checkpoint.taskFacts.decisions, first.checkpoint.taskFacts.decisions);
    assert.deepEqual(back.portable.handoff.verifications, first.portable.handoff.verifications);
    // Small handoff, not inherited conversation: each switch seeds 2 messages.
    assert.deepEqual((back.checkpoint.taskFacts.transcript as unknown[]).length, 2);
    assert.match(String((back.checkpoint.taskFacts.transcript as Array<{ content: string }>)[0]!.content), /from anthropic-messages\/claude-x/);
    assert.equal((back.checkpoint.taskFacts.providerSwitches as unknown[]).length, 2);
  });

  it("opaque provider state and unsupported message types are not forwarded", async () => {
    const seen: { body?: string } = {};
    const to = anthropic(seen);
    const res = switchProvider({ toolCalls: LEDGER, run: run(), checkpoint: checkpoint(), events: EVENTS, to, toModelId: "claude-x", now: () => NOW });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    for await (const _ of to.stream({ modelId: "claude-x", messages: res.messages })) {
      // drain
    }
    const everything = JSON.stringify([res.portable, res.checkpoint, res.messages, seen.body]);
    for (const o of OPAQUE) assert.ok(!everything.includes(o), `leaked ${o}`);
    assert.equal(res.checkpoint.taskFacts.providerState, undefined);
    assert.equal(res.checkpoint.taskFacts.promptCache, undefined);
    // Owner decision: small verified handoff, not full conversation inheritance.
    assert.deepEqual(res.portable.transcript.map((m) => m.role), ["system", "user"]);
    assert.ok(!JSON.stringify(res.messages).includes("Patching."));
    assert.ok(res.portable.dropped.includes("taskFacts.providerState"));
    assert.ok(res.portable.dropped.includes("transcript:not_inherited(5)"));
  });

  it("refuses to switch with a pending tool call (checkpoint or ledger)", () => {
    const a = switchProvider({ toolCalls: LEDGER, run: run(), checkpoint: checkpoint({ pendingCalls: ["c9"] }), events: EVENTS, to: new FakeProvider(), toModelId: "f" });
    assert.deepEqual(a.ok ? null : a.reason, "pending_tool_calls");
    const unknownCall = {
      id: "c10",
      runId: "r1",
      name: "run_command",
      input: {},
      inputDigest: "d",
      policyDecision: "allow",
      lifecycle: "outcome_unknown",
    } as ToolCall;
    const b = switchProvider({ run: run(), checkpoint: checkpoint(), events: EVENTS, toolCalls: [...LEDGER, unknownCall], to: new FakeProvider(), toModelId: "f" });
    assert.equal(b.ok ? null : b.reason, "pending_tool_calls");
    assert.match(b.ok ? "" : b.detail, /c10/);
  });

  it("refuses without a checkpoint, while running, or onto the same provider", () => {
    const fake = new FakeProvider();
    assert.equal((switchProvider({ toolCalls: LEDGER, run: run(), checkpoint: undefined, events: [], to: fake, toModelId: "f" }) as { reason: string }).reason, "no_checkpoint");
    assert.equal((switchProvider({ toolCalls: LEDGER, run: run({ state: "running" }), checkpoint: checkpoint(), events: [], to: fake, toModelId: "f" }) as { reason: string }).reason, "run_active");
    assert.equal((switchProvider({ toolCalls: LEDGER, run: run({ providerId: fake.id, modelId: "f" }), checkpoint: checkpoint(), events: [], to: fake, toModelId: "f" }) as { reason: string }).reason, "same_provider");
  });

  it("budget: refuses with an unreconciled reservation; no reservation crosses; spend kept", () => {
    const fake = new FakeProvider();
    const held = run({ budget: { ...freshBudget(5), reservedUsd: 0.1 } });
    const r = switchProvider({ toolCalls: LEDGER, run: held, checkpoint: checkpoint(), events: EVENTS, to: fake, toModelId: "f" });
    assert.equal(r.ok ? null : r.reason, "reservation_in_flight");
    const ok = switchProvider({ toolCalls: LEDGER, run: run(), checkpoint: checkpoint(), events: EVENTS, to: fake, toModelId: "f" });
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    assert.equal(ok.run.budget!.reservedUsd, 0);
    assert.equal(ok.run.budget!.spentKnownUsd, 0.42);
    assert.equal(ok.run.budget!.estimatedLimitUsd, 5);
  });

  it("toPortableCheckpoint redacts secret-shaped strings", () => {
    const cp = checkpoint();
    (cp.taskFacts.transcript as unknown[]).push({ role: "user", content: "key sk-proj-abcdefghijkl" });
    cp.taskFacts.goal = "Use key sk-proj-abcdefghijkl to deploy";
    const p = toPortableCheckpoint({ run: run(), checkpoint: cp, events: EVENTS });
    assert.ok(!JSON.stringify(p).includes("sk-proj-abcdefghijkl"));
    assert.deepEqual(verifyPortableCheckpoint(p), []);
  });

  it("P1-1: stale checkpoint sequence is rejected", () => {
    const r = switchProvider({ run: run({ lastEventSequence: 10 }), checkpoint: checkpoint(), events: EVENTS, toolCalls: LEDGER, to: new FakeProvider(), toModelId: "f" });
    assert.equal(r.ok ? null : r.reason, "stale_checkpoint");
    const older = switchProvider({ run: run(), checkpoint: checkpoint({ lastEventSequence: 8 }), events: EVENTS, toolCalls: LEDGER, to: new FakeProvider(), toModelId: "f" });
    assert.equal(older.ok ? null : older.reason, "stale_checkpoint");
  });

  it("P1-1: runState and taskId must match the run", () => {
    const st = switchProvider({ run: run({ state: "budget_exhausted" }), checkpoint: checkpoint(), events: EVENTS, toolCalls: LEDGER, to: new FakeProvider(), toModelId: "f" });
    assert.equal(st.ok ? null : st.reason, "checkpoint_state_mismatch");
    const cp = checkpoint();
    cp.taskFacts.taskId = "other-task";
    const tk = switchProvider({ run: run(), checkpoint: cp, events: EVENTS, toolCalls: LEDGER, to: new FakeProvider(), toModelId: "f" });
    assert.equal(tk.ok ? null : tk.reason, "task_mismatch");
    const term = switchProvider({ run: run({ state: "completed" }), checkpoint: checkpoint({ runState: "completed" }), events: EVENTS, toolCalls: LEDGER, to: new FakeProvider(), toModelId: "f" });
    assert.equal(term.ok ? null : term.reason, "run_not_switchable");
  });

  it("P1-1: a missing toolCalls ledger is refused, never a bypass", () => {
    const r = switchProvider({ run: run(), checkpoint: checkpoint(), events: EVENTS, toolCalls: undefined, to: new FakeProvider(), toModelId: "f" });
    assert.equal(r.ok ? null : r.reason, "ledger_unavailable");
  });

  it("P1-1: ledger that disagrees with the event log is refused", () => {
    // tool_finished for c-apply exists in events but the ledger is empty.
    const missing = switchProvider({ run: run(), checkpoint: checkpoint(), events: EVENTS, toolCalls: [], to: new FakeProvider(), toModelId: "f" });
    assert.equal(missing.ok ? null : missing.reason, "ledger_mismatch");
    assert.match(missing.ok ? "" : missing.detail, /c-apply/);
    // Ledger entry from another run.
    const foreign = switchProvider({ run: run(), checkpoint: checkpoint(), events: EVENTS, toolCalls: [...LEDGER, { ...LEDGER[0]!, id: "x", runId: "r2" }], to: new FakeProvider(), toModelId: "f" });
    assert.equal(foreign.ok ? null : foreign.reason, "ledger_mismatch");
  });

  it("handoff validation: required facts present, secrets redacted, digest verified", () => {
    const cp = checkpoint();
    delete cp.taskFacts.goal;
    const noGoal = switchProvider({ run: run(), checkpoint: cp, events: EVENTS, toolCalls: LEDGER, to: new FakeProvider(), toModelId: "f" });
    assert.equal(noGoal.ok ? null : noGoal.reason, "handoff_invalid");
    assert.match(noGoal.ok ? "" : noGoal.detail, /missing task fact: goal/);

    const ok = switchProvider({ run: run(), checkpoint: checkpoint(), events: EVENTS, toolCalls: LEDGER, to: new FakeProvider(), toModelId: "f" });
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    assert.deepEqual(verifyPortableCheckpoint(ok.portable), []);
    assert.equal(ok.portable.verifiedAgainst.checkpointSequence, 9);
    // Tampering (or an unredacted secret slipped in later) is detected.
    const tampered = structuredClone(ok.portable);
    tampered.transcript[1]!.content += " api_key=sk-live-abcdefghijk";
    const problems = verifyPortableCheckpoint(tampered);
    assert.ok(problems.some((p) => p.includes("unredacted secret")));
    assert.ok(problems.some((p) => p.includes("digest mismatch")));
  });
});

