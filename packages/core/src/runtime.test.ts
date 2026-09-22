import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { FakeProvider } from "@kur3/providers";
import { HarnessRuntime } from "./runtime.js";

describe("HarnessRuntime offline loop", () => {
  let workspace: string;
  let dataDir: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kur3-rt-ws-"));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kur3-rt-data-"));
    fs.mkdirSync(path.join(workspace, "src"));
    fs.writeFileSync(
      path.join(workspace, "src", "hello.ts"),
      'export function hello(): string {\n  return "hello";\n}\n',
    );
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("edits fixture with fake provider and records verification", async () => {
    const runtime = new HarnessRuntime({
      workspaceRoot: workspace,
      dataDir,
      provider: new FakeProvider({ scenario: "edit_hello" }),
    });

    const result = await runtime.startRun({
      task: {
        id: "task-edit",
        projectId: "proj-1",
        goal: "Change hello greeting to hello, kur3",
        scope: ["src/hello.ts"],
        mode: "run",
        acceptanceCriteria: [
          {
            id: "ac1",
            description: "hello.ts contains hello, kur3",
            check: {
              type: "file_contains",
              path: "src/hello.ts",
              substring: "hello, kur3",
            },
          },
        ],
      },
    });

    assert.equal(result.run.state, "completed");
    assert.equal(result.verifications[0]?.outcome, "passed");
    const content = fs.readFileSync(
      path.join(workspace, "src", "hello.ts"),
      "utf8",
    );
    assert.match(content, /hello, kur3/);
    const events = runtime.getStore().listEvents(result.run.id);
    assert.ok(events.some((e) => e.type === "tool_finished"));
    assert.ok(events.some((e) => e.type === "verification_recorded"));
  });

  it("plan mode cannot apply_patch", async () => {
    const runtime = new HarnessRuntime({
      workspaceRoot: workspace,
      dataDir,
      provider: new FakeProvider({ scenario: "edit_hello" }),
    });

    const before = fs.readFileSync(
      path.join(workspace, "src", "hello.ts"),
      "utf8",
    );

    const result = await runtime.startRun({
      task: {
        id: "task-plan",
        projectId: "proj-1",
        goal: "Plan an edit",
        scope: ["src/hello.ts"],
        mode: "plan",
        acceptanceCriteria: [],
      },
    });

    const after = fs.readFileSync(
      path.join(workspace, "src", "hello.ts"),
      "utf8",
    );
    assert.equal(before, after);
    const events = runtime.getStore().listEvents(result.run.id);
    assert.ok(
      events.some(
        (e) =>
          e.type === "tool_denied" ||
          (e.type === "tool_finished" &&
            JSON.stringify(e.payload).includes("proposed")),
      ) || result.run.state === "completed",
    );
  });
});
