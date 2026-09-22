import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, before, after } from "node:test";
import { HarnessRuntime } from "@kur3/core";
import { FakeProvider } from "@kur3/providers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
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

describe("integration: offline edit task", () => {
  let workRoot: string;

  before(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kur3-int-"));
  });

  after(() => {
    fs.rmSync(workRoot, { recursive: true, force: true });
  });

  it("A01/A02-ish: fake provider edits fixture without network", async () => {
    const workspace = path.join(workRoot, "project");
    const dataDir = path.join(workRoot, "data");
    copyDir(fixtureSrc, workspace);

    const runtime = new HarnessRuntime({
      workspaceRoot: workspace,
      dataDir,
      provider: new FakeProvider({ scenario: "edit_hello" }),
    });

    const result = await runtime.startRun({
      task: {
        id: "int-1",
        projectId: "demo",
        goal: "edit hello",
        scope: ["src/hello.ts"],
        mode: "run",
        acceptanceCriteria: [
          {
            id: "ac1",
            description: "contains hello, kur3",
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
  });

  it("A12-ish: duplicate resume lease rejected", () => {
    const dataDir = path.join(workRoot, "lease-data");
    const workspace = path.join(workRoot, "lease-ws");
    fs.mkdirSync(workspace, { recursive: true });
    const a = new HarnessRuntime({
      workspaceRoot: workspace,
      dataDir,
      provider: new FakeProvider({ scenario: "greet" }),
      holderId: "a",
    });
    const store = a.getStore();
    const now = new Date().toISOString();
    store.createRun({
      id: "lease-run",
      taskId: "t",
      providerId: "fake",
      modelId: "fake-v1",
      state: "paused",
      limits: {
        maxToolSteps: 5,
        maxDurationMs: 60_000,
        maxCommandMs: 1000,
        maxTransientRetries: 1,
        maxIdenticalFailures: 2,
      },
      createdAt: now,
      updatedAt: now,
      toolStepsUsed: 0,
      lastEventSequence: 0,
    });
    assert.equal(store.acquireLease("lease-run", "a").ok, true);
    assert.equal(store.acquireLease("lease-run", "b").ok, false);
  });
});
