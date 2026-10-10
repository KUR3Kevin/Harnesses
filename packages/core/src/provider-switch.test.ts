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
import { switchProvider, toPortableCheckpoint } from "./provider-switch.js";

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
    const res = switchProvider({
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
    const first = switchProvider({ run: run(), checkpoint: checkpoint(), events: EVENTS, to: anthropic({}), toModelId: "claude-x", now: () => NOW });
    assert.ok(first.ok);
    if (!first.ok) return;
    const back = switchProvider({
      run: first.run,
      checkpoint: first.checkpoint,
      events: EVENTS,
      to: new OpenAICompatibleProvider({ baseUrl: "https://example.test/v1", apiKey: "sk-test-not-real", fetch: async () => new Response("") }),
      toModelId: "gpt-x",
      now: () => NOW,
    });
    assert.ok(back.ok);
    if (!back.ok) return;
    assert.equal(back.checkpoint.taskFacts.goal, first.checkpoint.taskFacts.goal);
    assert.deepEqual(back.checkpoint.taskFacts.decisions, first.checkpoint.taskFacts.decisions);
    assert.deepEqual(back.portable.handoff.verifications, first.portable.handoff.verifications);
    assert.deepEqual(back.checkpoint.taskFacts.transcript, first.checkpoint.taskFacts.transcript);
    assert.equal((back.checkpoint.taskFacts.providerSwitches as unknown[]).length, 2);
  });

  it("opaque provider state and unsupported message types are not forwarded", async () => {
    const seen: { body?: string } = {};
    const to = anthropic(seen);
    const res = switchProvider({ run: run(), checkpoint: checkpoint(), events: EVENTS, to, toModelId: "claude-x", now: () => NOW });
    assert.ok(res.ok);
    if (!res.ok) return;
    for await (const _ of to.stream({ modelId: "claude-x", messages: res.messages })) {
      // drain
    }
    const everything = JSON.stringify([res.portable, res.checkpoint, res.messages, seen.body]);
    for (const o of OPAQUE) assert.ok(!everything.includes(o), `leaked ${o}`);
    assert.equal(res.checkpoint.taskFacts.providerState, undefined);
    assert.equal(res.checkpoint.taskFacts.promptCache, undefined);
    assert.deepEqual(res.portable.transcript.map((m) => m.role), ["user", "assistant", "tool"]);
    assert.ok(res.portable.dropped.includes("taskFacts.providerState"));
    assert.ok(res.portable.dropped.includes("transcript.reasoning_signature"));
    assert.ok(res.portable.dropped.some((d) => d.endsWith(":unsupported")));
  });

  it("refuses to switch with a pending tool call (checkpoint or ledger)", () => {
    const a = switchProvider({ run: run(), checkpoint: checkpoint({ pendingCalls: ["c9"] }), events: EVENTS, to: new FakeProvider(), toModelId: "f" });
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
    const b = switchProvider({ run: run(), checkpoint: checkpoint(), events: EVENTS, toolCalls: [unknownCall], to: new FakeProvider(), toModelId: "f" });
    assert.equal(b.ok ? null : b.reason, "pending_tool_calls");
    assert.match(b.ok ? "" : b.detail, /c10/);
  });

  it("refuses without a checkpoint, while running, or onto the same provider", () => {
    const fake = new FakeProvider();
    assert.equal((switchProvider({ run: run(), checkpoint: undefined, events: [], to: fake, toModelId: "f" }) as { reason: string }).reason, "no_checkpoint");
    assert.equal((switchProvider({ run: run({ state: "running" }), checkpoint: checkpoint(), events: [], to: fake, toModelId: "f" }) as { reason: string }).reason, "run_active");
    assert.equal((switchProvider({ run: run({ providerId: fake.id, modelId: "f" }), checkpoint: checkpoint(), events: [], to: fake, toModelId: "f" }) as { reason: string }).reason, "same_provider");
  });

  it("budget: refuses with an unreconciled reservation; no reservation crosses; spend kept", () => {
    const fake = new FakeProvider();
    const held = run({ budget: { ...freshBudget(5), reservedUsd: 0.1 } });
    const r = switchProvider({ run: held, checkpoint: checkpoint(), events: EVENTS, to: fake, toModelId: "f" });
    assert.equal(r.ok ? null : r.reason, "reservation_in_flight");
    const ok = switchProvider({ run: run(), checkpoint: checkpoint(), events: EVENTS, to: fake, toModelId: "f" });
    assert.ok(ok.ok);
    if (!ok.ok) return;
    assert.equal(ok.run.budget!.reservedUsd, 0);
    assert.equal(ok.run.budget!.spentKnownUsd, 0.42);
    assert.equal(ok.run.budget!.estimatedLimitUsd, 5);
  });

  it("toPortableCheckpoint redacts secret-shaped strings", () => {
    const cp = checkpoint();
    (cp.taskFacts.transcript as unknown[]).push({ role: "user", content: "key sk-proj-abcdefghijkl" });
    const p = toPortableCheckpoint({ run: run(), checkpoint: cp, events: EVENTS });
    assert.ok(!JSON.stringify(p).includes("sk-proj-abcdefghijkl"));
  });
});
