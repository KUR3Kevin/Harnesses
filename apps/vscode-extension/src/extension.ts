import * as vscode from "vscode";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeHostClient, defaultHostPaths } from "./host-client.js";
import { Kur3Panel } from "./panel.js";
import { VsCodeCredentialStore } from "./credentials.js";

interface BridgeStatus {
  runId?: string;
  state?: string;
  events: string[];
  workspaceRoot?: string;
  changedFile?: string;
}

let client: BridgeHostClient | undefined;
let status: BridgeStatus = { events: [] };
let credentials: VsCodeCredentialStore | undefined;

function repoRootFromExtension(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function getClient(): BridgeHostClient {
  if (!client) {
    const paths = defaultHostPaths(import.meta.url);
    client = new BridgeHostClient({
      hostEntry: paths.hostEntry,
      cwd: paths.cwd,
      nodeArgs: paths.nodeArgs,
    });
  }
  return client;
}

function protocolVersion(): string {
  return "0.1.0";
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

async function startOfflineDemo(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kur3-vscode-"));
  let workspace = folder?.uri.fsPath;
  if (!workspace) {
    workspace = path.join(workRoot, "project");
    const repoFixture = path.join(
      repoRootFromExtension(),
      "fixtures",
      "demo-project",
    );
    if (fs.existsSync(repoFixture)) {
      copyDir(repoFixture, workspace);
    } else {
      fs.mkdirSync(workspace, { recursive: true });
    }
  }
  const dataDir = path.join(workRoot, "harness-data");
  fs.mkdirSync(dataDir, { recursive: true });

  const c = getClient();
  const started = (await c.request({
    protocolVersion: protocolVersion(),
    requestId: `start-${Date.now()}`,
    command: "start_run",
    params: {
      task: {
        id: "vscode-offline-demo",
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
  })) as {
    ok: boolean;
    run?: { id: string; state: string };
    error?: { message: string };
  };

  if (!started.ok || !started.run) {
    void vscode.window.showErrorMessage(
      `KUR3 start_run failed: ${started.error?.message ?? "unknown"}`,
    );
    return;
  }

  const sub = (await c.request({
    protocolVersion: protocolVersion(),
    requestId: `sub-${Date.now()}`,
    command: "subscribe_events",
    params: { runId: started.run.id, afterSequence: 0 },
  })) as {
    ok: boolean;
    run?: { id: string; state: string };
    events?: Array<{ sequence: number; type: string; payload: unknown }>;
    summary?: string;
  };

  status = {
    runId: started.run.id,
    state: sub.run?.state ?? started.run.state,
    workspaceRoot: workspace,
    changedFile: path.join(workspace, "src", "hello.ts"),
    events: (sub.events ?? []).map(
      (e) => `#${e.sequence} ${e.type} ${JSON.stringify(e.payload)}`,
    ),
  };
  if (sub.summary) {
    status.events.push(`summary: ${sub.summary}`);
  }

  Kur3Panel.current?.updateFromStatus(status);

  if (status.changedFile && fs.existsSync(status.changedFile)) {
    try {
      await vscode.commands.executeCommand(
        "vscode.open",
        vscode.Uri.file(status.changedFile),
      );
    } catch {
      /* ignore when command unavailable */
    }
  }

  void vscode.window.showInformationMessage(
    `KUR3 offline run ${status.state}: ${status.runId}`,
  );
}

async function cancelRun(): Promise<void> {
  if (!status.runId || !client) {
    void vscode.window.showWarningMessage("KUR3: no active run");
    return;
  }
  const res = (await client.request({
    protocolVersion: protocolVersion(),
    requestId: `cancel-${Date.now()}`,
    command: "cancel_run",
    params: { runId: status.runId },
  })) as { ok: boolean; run?: { state: string } };
  status = {
    ...status,
    state: res.run?.state ?? status.state,
  };
  Kur3Panel.current?.updateFromStatus(status);
}

export function activate(context: vscode.ExtensionContext): void {
  credentials = new VsCodeCredentialStore(context.secrets);

  const bridgeApi = {
    startOfflineDemo,
    cancelRun,
    getStatus: () => status,
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("kur3.openPanel", () => {
      Kur3Panel.show(context, bridgeApi);
    }),
    vscode.commands.registerCommand("kur3.startOfflineDemo", async () => {
      Kur3Panel.show(context, bridgeApi);
      await startOfflineDemo();
    }),
    vscode.commands.registerCommand("kur3.cancelRun", async () => {
      await cancelRun();
    }),
  );

  // Wire credential interface; FakeProvider does not read secrets.
  void credentials.get("fake");
}

export async function deactivate(): Promise<void> {
  await client?.dispose();
  client = undefined;
}
