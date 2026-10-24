import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { RunStore } from "./run-store.js";
import type { Run } from "@kur3/contracts";

function sampleRun(id: string): Run {
  const now = new Date().toISOString();
  return {
    id,
    taskId: "task-1",
    providerId: "fake",
    modelId: "fake-v1",
    state: "queued",
    limits: {
      maxToolSteps: 30,
      maxDurationMs: 900_000,
      maxCommandMs: 60_000,
      maxTransientRetries: 2,
      maxIdenticalFailures: 3,
    },
    createdAt: now,
    updatedAt: now,
    toolStepsUsed: 0,
    lastEventSequence: 0,
  };
}

describe("RunStore", () => {
  let dir: string;
  let store: RunStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kur3-store-"));
    store = new RunStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists ordered events across reload", () => {
    store.createRun(sampleRun("r1"));
    store.appendEvent("r1", "run_started", { ok: true });
    store.appendEvent("r1", "model_text_delta", { text: "hi" });
    const reloaded = new RunStore(dir);
    const events = reloaded.listEvents("r1");
    assert.equal(events.length, 2);
    assert.equal(events[0]?.sequence, 1);
    assert.equal(events[1]?.sequence, 2);
    assert.equal(reloaded.getRun("r1")?.lastEventSequence, 2);
  });

  it("rejects duplicate resume lease", () => {
    store.createRun(sampleRun("r2"));
    const a = store.acquireLease("r2", "holder-a");
    assert.equal(a.ok, true);
    const b = store.acquireLease("r2", "holder-b");
    assert.equal(b.ok, false);
  });

  it("reloads a lease taken by another store instance", () => {
    const early = new RunStore(dir);
    store.createRun(sampleRun("r4"));
    const held = store.acquireLease("r4", "holder-a");
    assert.equal(held.ok, true);
    const again = early.acquireLease("r4", "holder-b");
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.holderId, "holder-a");
  });

  it("round-trips tool calls", () => {
    store.createRun(sampleRun("r5"));
    store.upsertToolCall({
      id: "c1",
      runId: "r5",
      name: "apply_patch",
      input: { path: "a.txt" },
      inputDigest: "abc",
      policyDecision: "allow",
      lifecycle: "running",
      mutates: true,
      expectedPreHash: "pre",
      expectedPostHash: "post",
    });
    const reloaded = new RunStore(dir);
    const calls = reloaded.listToolCalls("r5");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.lifecycle, "running");
    assert.equal(calls[0]?.expectedPostHash, "post");
  });

  it("rejects illegal state transition", () => {
    store.createRun(sampleRun("r3"));
    store.updateRunState("r3", "running");
    store.updateRunState("r3", "completed");
    assert.throws(() => store.updateRunState("r3", "running"));
  });

  it("W10: saveCheckpointWithEvent covers its own event; commitProviderSwitch is atomic + idempotent", () => {
    store.createRun(sampleRun("rs"));
    const cp = store.saveCheckpointWithEvent({ runId: "rs", taskFacts: { taskId: "task-1" }, pendingCalls: [], savedAt: new Date().toISOString() });
    assert.equal(cp.lastEventSequence, store.getRun("rs")!.lastEventSequence);
    assert.equal(cp.runState, store.getRun("rs")!.state);
    const args = {
      requestId: "req-1",
      runId: "rs",
      expectedLastEventSequence: cp.lastEventSequence,
      runPatch: { providerId: "other", modelId: "m2" },
      checkpoint: { runId: "rs", taskFacts: { taskId: "task-1" }, pendingCalls: [], savedAt: new Date().toISOString() },
      handoffDigest: "sha256:" + "0".repeat(64),
    };
    const stale = store.commitProviderSwitch({ ...args, expectedLastEventSequence: cp.lastEventSequence - 1 });
    assert.equal(stale.ok ? null : stale.reason, "stale_run");
    const first = store.commitProviderSwitch(args);
    assert.ok(first.ok && !first.duplicate);
    const reloaded = new RunStore(dir);
    assert.equal(reloaded.getRun("rs")!.providerId, "other");
    assert.equal(reloaded.getCheckpoint("rs")!.lastEventSequence, reloaded.getRun("rs")!.lastEventSequence);
    assert.equal(reloaded.listEvents("rs").filter((e) => e.type === "provider_switched").length, 1);
    const again = reloaded.commitProviderSwitch(args);
    assert.ok(again.ok && again.duplicate);
    assert.equal(reloaded.listEvents("rs").filter((e) => e.type === "provider_switched").length, 1);
  });
});
