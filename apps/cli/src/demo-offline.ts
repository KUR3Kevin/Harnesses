#!/usr/bin/env node
/**
 * Reproducible offline demo: no network, no API keys.
 * Copies the fixture project, runs the fake-provider harness, prints evidence.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessRuntime } from "@kur3/core";
import { FakeProvider } from "@kur3/providers";

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

async function main(): Promise<void> {
  console.log("KUR3 Harness — offline demo");
  console.log("============================");
  console.log(`Node: ${process.version}`);
  console.log(`Repo: ${repoRoot}`);
  console.log("Network: not used (FakeProvider)");
  console.log("");

  if (!fs.existsSync(fixtureSrc)) {
    console.error(`Fixture missing: ${fixtureSrc}`);
    process.exit(1);
  }

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kur3-demo-"));
  const workspace = path.join(workRoot, "project");
  const dataDir = path.join(workRoot, "harness-data");
  copyDir(fixtureSrc, workspace);

  const before = fs.readFileSync(
    path.join(workspace, "src", "hello.ts"),
    "utf8",
  );
  console.log("Before:\n" + before);

  const runtime = new HarnessRuntime({
    workspaceRoot: workspace,
    dataDir,
    provider: new FakeProvider({ scenario: "edit_hello" }),
    holderId: "demo-offline",
  });

  const result = await runtime.startRun({
    task: {
      id: "demo-task-1",
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
  });

  const after = fs.readFileSync(
    path.join(workspace, "src", "hello.ts"),
    "utf8",
  );
  console.log("After:\n" + after);
  console.log(`Run state: ${result.run.state}`);
  console.log(`Summary: ${result.summary || "(none)"}`);
  console.log("Verifications:");
  for (const v of result.verifications) {
    console.log(`  - [${v.outcome}] ${v.criterionId}: ${v.evidence ?? ""}`);
  }

  const events = runtime.getStore().listEvents(result.run.id);
  console.log(`Events recorded: ${events.length}`);
  console.log(`Workspace (temp): ${workspace}`);
  console.log(`Data dir (temp): ${dataDir}`);

  const failed = result.verifications.some((v) => v.outcome === "failed");
  const ok =
    result.run.state === "completed" &&
    !failed &&
    after.includes("hello, kur3");

  if (!ok) {
    console.error("\nDEMO FAILED");
    process.exit(1);
  }
  console.log("\nDEMO OK (offline)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
