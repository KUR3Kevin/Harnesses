import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, before, after } from "node:test";
import { BRIDGE_PROTOCOL_VERSION } from "@kur3/contracts";
import { InProcessHarnessBridge } from "@kur3/core";
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

describe("integration: extension bridge offline", () => {
  let workRoot: string;

  before(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kur3-ext-int-"));
  });

  after(() => {
    fs.rmSync(workRoot, { recursive: true, force: true });
  });

  it("A16-ish: reconnect subscribe does not duplicate run execution", async () => {
    const workspace = path.join(workRoot, "project");
    const dataDir = path.join(workRoot, "data");
    copyDir(fixtureSrc, workspace);

    const bridge = new InProcessHarnessBridge({
      provider: new FakeProvider({ scenario: "edit_hello" }),
      holderId: "ext-int",
    });

    const started = await bridge.handle({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: "i1",
      command: "start_run",
      params: {
        task: {
          id: "ext-int-1",
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
        workspaceRoot: workspace,
        dataDir,
      },
    });
    assert.equal(started.ok, true);
    const runId = started.run!.id;

    const first = await bridge.handle({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: "i2",
      command: "subscribe_events",
      params: { runId, afterSequence: 0 },
    });
    assert.equal(first.ok, true);
    assert.equal(first.run?.state, "completed");

    const reconnect = await bridge.handle({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: "i3",
      command: "subscribe_events",
      params: { runId, afterSequence: 0 },
    });
    assert.equal(reconnect.ok, true);
    assert.equal(reconnect.events?.length, first.events?.length);
    assert.equal(bridge.getActiveRunId(), runId);
  });
});
