#!/usr/bin/env node
/**
 * Engine-side bridge host. Speaks one JSON BridgeRequest per stdin line and
 * writes one BridgeResponse per stdout line. Used by the VS Code extension
 * over stdio IPC so the extension process never freezes on model work and
 * never imports @kur3 packages into the extension host bundle.
 *
 * Also supports --once-offline for demo:extension-offline (no IPC loop).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { BRIDGE_PROTOCOL_VERSION } from "@kur3/contracts";
import { InProcessHarnessBridge } from "@kur3/core";
import { FakeProvider } from "@kur3/providers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function createOfflineBridge(): InProcessHarnessBridge {
  return new InProcessHarnessBridge({
    provider: new FakeProvider({ scenario: "edit_hello" }),
    holderId: "vscode-bridge-host",
  });
}

async function runOnceOffline(): Promise<void> {
  const fixtureSrc = path.join(repoRoot, "fixtures", "demo-project");
  if (!fs.existsSync(fixtureSrc)) {
    console.error(`Fixture missing: ${fixtureSrc}`);
    process.exit(1);
  }
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kur3-ext-demo-"));
  const workspace = path.join(workRoot, "project");
  const dataDir = path.join(workRoot, "harness-data");
  copyDir(fixtureSrc, workspace);

  const bridge = createOfflineBridge();
  const started = await bridge.handle({
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    requestId: "demo-start",
    command: "start_run",
    params: {
      task: {
        id: "ext-demo-task",
        projectId: "demo-project",
        goal: "Change the hello() return value to include kur3",
        scope: ["src/hello.ts"],
        mode: "run",
        acceptanceCriteria: [
          {
            id: "A02-local",
            description: "src/hello.ts contains hello, kur3",
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
  });

  if (!started.ok || !started.run) {
    console.error("start_run failed", started.error);
    process.exit(1);
  }

  const sub = await bridge.handle({
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    requestId: "demo-sub",
    command: "subscribe_events",
    params: { runId: started.run.id, afterSequence: 0 },
  });

  const after = fs.readFileSync(
    path.join(workspace, "src", "hello.ts"),
    "utf8",
  );
  console.log("KUR3 Harness — extension bridge offline demo");
  console.log("===========================================");
  console.log(`Run: ${started.run.id} state=${sub.run?.state}`);
  console.log(`Events: ${sub.events?.length ?? 0}`);
  console.log(`Summary: ${sub.summary ?? "(none)"}`);
  console.log(`Workspace: ${workspace}`);
  console.log("After:\n" + after);

  const ok =
    sub.run?.state === "completed" &&
    after.includes("hello, kur3") &&
    (sub.events?.length ?? 0) > 0;

  // Reconnect check: subscribe again must not create another run
  const reconnect = await bridge.handle({
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    requestId: "demo-reconnect",
    command: "subscribe_events",
    params: { runId: started.run.id, afterSequence: 0 },
  });
  const sameCount = reconnect.events?.length === sub.events?.length;

  if (!ok || !sameCount) {
    console.error("\nDEMO EXTENSION-OFFLINE FAILED");
    process.exit(1);
  }
  console.log("\nDEMO EXTENSION-OFFLINE OK");
}

async function runIpcLoop(): Promise<void> {
  const bridge = createOfflineBridge();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch (err) {
      const response = {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        requestId: "unknown",
        ok: false,
        error: {
          code: "invalid_request",
          message: err instanceof Error ? err.message : String(err),
        },
      };
      process.stdout.write(JSON.stringify(response) + "\n");
      continue;
    }
    const response = await bridge.handle(raw);
    process.stdout.write(JSON.stringify(response) + "\n");
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--once-offline")) {
    await runOnceOffline();
    return;
  }
  await runIpcLoop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
