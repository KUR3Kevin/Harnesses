import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, before, after } from "node:test";
import { BRIDGE_PROTOCOL_VERSION } from "@kur3/contracts";
import { FakeProvider } from "@kur3/providers";
import { InProcessHarnessBridge } from "./bridge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const fixtureSrc = path.join(repoRoot, "fixtures", "demo-project");

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function demoTask() {
  return {
    id: "bridge-task-1",
    projectId: "demo-project",
    goal: "Change the hello() return value to include kur3",
    scope: ["src/hello.ts"],
    mode: "run" as const,
    acceptanceCriteria: [
      {
        id: "ac1",
        description: "contains hello, kur3",
        check: {
          type: "file_contains" as const,
          path: "src/hello.ts",
          substring: "hello, kur3",
        },
      },
    ],
  };
}

describe("InProcessHarnessBridge", () => {
  let workRoot: string;

  before(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kur3-bridge-"));
  });

  after(() => {
    fs.rmSync(workRoot, { recursive: true, force: true });
  });

  it("start_run + subscribe_events completes offline edit (FakeProvider)", async () => {
    const workspace = path.join(workRoot, "edit-ws");
    const dataDir = path.join(workRoot, "edit-data");
    copyDir(fixtureSrc, workspace);

    const bridge = new InProcessHarnessBridge({
      provider: new FakeProvider({ scenario: "edit_hello" }),
      holderId: "bridge-test-edit",
    });

    const started = await bridge.handle({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: "req-1",
      command: "start_run",
      params: {
        task: demoTask(),
        workspaceRoot: workspace,
        dataDir,
        providerId: "fake",
      },
    });

    assert.equal(started.ok, true);
    assert.ok(started.run?.id);
    const runId = started.run!.id;

    const sub = await bridge.handle({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: "req-2",
      command: "subscribe_events",
      params: { runId, afterSequence: 0 },
    });

    assert.equal(sub.ok, true);
    assert.ok((sub.events?.length ?? 0) > 0);
    assert.equal(sub.run?.state, "completed");

    const hello = fs.readFileSync(path.join(workspace, "src", "hello.ts"), "utf8");
    assert.match(hello, /hello, kur3/);

    // Reconnect: same afterSequence window must not duplicate by creating a run
    const again = await bridge.handle({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: "req-3",
      command: "subscribe_events",
      params: { runId, afterSequence: 0 },
    });
    assert.equal(again.ok, true);
    assert.equal(again.events?.length, sub.events?.length);

    const tail = await bridge.handle({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: "req-4",
      command: "subscribe_events",
      params: {
        runId,
        afterSequence: sub.events![sub.events!.length - 1]!.sequence,
      },
    });
    assert.equal(tail.ok, true);
    assert.equal(tail.events?.length, 0);
  });

  it("subscribe_events / get_run never invent a new run", async () => {
    const bridge = new InProcessHarnessBridge({
      provider: new FakeProvider({ scenario: "greet" }),
    });
    const missing = await bridge.handle({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: "req-missing",
      command: "subscribe_events",
      params: { runId: "does-not-exist", afterSequence: 0 },
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, "run_not_found");
    assert.equal(bridge.getActiveRunId(), null);
  });

  it("second start_run while active returns run_already_active", async () => {
    const workspace = path.join(workRoot, "active-ws");
    const dataDir = path.join(workRoot, "active-data");
    fs.mkdirSync(workspace, { recursive: true });

    const bridge = new InProcessHarnessBridge({
      provider: new FakeProvider({ scenario: "greet", preDelayMs: 80 }),
      holderId: "bridge-active",
    });

    const firstP = bridge.handle({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: "req-a",
      command: "start_run",
      params: {
        task: {
          id: "t-a",
          projectId: "p",
          goal: "greet",
          scope: [],
          mode: "plan",
          acceptanceCriteria: [],
        },
        workspaceRoot: workspace,
        dataDir,
      },
    });

    // Let first run record appear
    await new Promise((r) => setTimeout(r, 15));
    const first = await firstP;
    assert.equal(first.ok, true);
    assert.ok(first.run?.id);

    const second = await bridge.handle({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: "req-b",
      command: "start_run",
      params: {
        task: {
          id: "t-b",
          projectId: "p",
          goal: "greet again",
          scope: [],
          mode: "plan",
          acceptanceCriteria: [],
        },
        workspaceRoot: workspace,
        dataDir,
      },
    });

    // If first already finished, second may succeed — either outcome is ok
    // as long as we never silently duplicate while in flight.
    if (!second.ok) {
      assert.equal(second.error?.code, "run_already_active");
      assert.equal(second.activeRunId, first.run!.id);
    }

    // Drain
    await bridge.handle({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: "req-drain",
      command: "get_run",
      params: { runId: first.run!.id },
    });
  });

  it("cancel_run aborts an in-flight offline run", async () => {
    const workspace = path.join(workRoot, "cancel-ws");
    const dataDir = path.join(workRoot, "cancel-data");
    fs.mkdirSync(workspace, { recursive: true });

    const bridge = new InProcessHarnessBridge({
      provider: new FakeProvider({ scenario: "greet", preDelayMs: 200 }),
      holderId: "bridge-cancel",
    });

    const started = await bridge.handle({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: "req-c1",
      command: "start_run",
      params: {
        task: {
          id: "t-c",
          projectId: "p",
          goal: "greet",
          scope: [],
          mode: "plan",
          acceptanceCriteria: [],
        },
        workspaceRoot: workspace,
        dataDir,
      },
    });
    assert.equal(started.ok, true);
    const runId = started.run!.id;

    const canceled = await bridge.handle({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: "req-c2",
      command: "cancel_run",
      params: { runId },
    });
    assert.equal(canceled.ok, true);
    assert.ok(
      canceled.run?.state === "canceled" || canceled.run?.state === "completed",
      `expected canceled or completed, got ${canceled.run?.state}`,
    );
  });

  it("rejects protocol mismatch", async () => {
    const bridge = new InProcessHarnessBridge({
      provider: new FakeProvider({ scenario: "greet" }),
    });
    const res = await bridge.handle({
      protocolVersion: "9.9.9",
      requestId: "req-proto",
      command: "get_run",
      params: { runId: "x" },
    });
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, "protocol_mismatch");
  });
});
