import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, after } from "node:test";
import { BridgeHostClient, defaultHostPaths } from "./host-client.js";

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

describe("BridgeHostClient stdio IPC", () => {
  const clients: BridgeHostClient[] = [];

  after(async () => {
    for (const c of clients) await c.dispose();
  });

  it("start_run + subscribe_events over stdio (FakeProvider offline)", async () => {
    const paths = defaultHostPaths(import.meta.url);
    // When tests run from src via tsx, hostEntry should be the .ts file
    const hostEntry = path.join(__dirname, "bridge-host-main.ts");
    assert.ok(fs.existsSync(hostEntry), `missing ${hostEntry}`);

    const client = new BridgeHostClient({
      hostEntry,
      cwd: paths.cwd,
      nodeArgs: ["--import", "tsx"],
    });
    clients.push(client);

    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kur3-ipc-"));
    const workspace = path.join(workRoot, "project");
    const dataDir = path.join(workRoot, "data");
    copyDir(fixtureSrc, workspace);

    const started = (await client.request({
      protocolVersion: "0.1.0",
      requestId: "ipc-1",
      command: "start_run",
      params: {
        task: {
          id: "ipc-task",
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
        providerId: "fake",
      },
    })) as { ok: boolean; run?: { id: string } };

    assert.equal(started.ok, true);
    assert.ok(started.run?.id);

    const sub = (await client.request({
      protocolVersion: "0.1.0",
      requestId: "ipc-2",
      command: "subscribe_events",
      params: { runId: started.run!.id, afterSequence: 0 },
    })) as {
      ok: boolean;
      run?: { state: string };
      events?: unknown[];
    };

    assert.equal(sub.ok, true);
    assert.equal(sub.run?.state, "completed");
    assert.ok((sub.events?.length ?? 0) > 0);

    const hello = fs.readFileSync(
      path.join(workspace, "src", "hello.ts"),
      "utf8",
    );
    assert.match(hello, /hello, kur3/);

    // Reconnect must not start another run
    const again = (await client.request({
      protocolVersion: "0.1.0",
      requestId: "ipc-3",
      command: "subscribe_events",
      params: { runId: started.run!.id, afterSequence: 0 },
    })) as { ok: boolean; events?: unknown[] };
    assert.equal(again.ok, true);
    assert.equal(again.events?.length, sub.events?.length);
  });
});
