import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  FileWorker,
  createCommandWorker,
  DisabledCommandWorker,
} from "@kur3/worker";
import { executeTool } from "./executor.js";

describe("executeTool", () => {
  let root: string;
  let fileWorker: FileWorker;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kur3-tool-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), " const x = 1;\n");
    fileWorker = new FileWorker({ workspaceRoot: root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads via read_file", async () => {
    const commandWorker = createCommandWorker({ workspaceRoot: root });
    const r = (await executeTool(
      { fileWorker, commandWorker },
      "read_file",
      { path: "src/a.ts" },
    )) as { status: string };
    assert.equal(r.status, "ok");
  });

  it("rejects missing path", async () => {
    const commandWorker = createCommandWorker({ workspaceRoot: root });
    await assert.rejects(() =>
      executeTool({ fileWorker, commandWorker }, "read_file", {}),
    );
  });

  it("runs run_command through isolated worker", async () => {
    const commandWorker = createCommandWorker({ workspaceRoot: root });
    const r = (await executeTool(
      { fileWorker, commandWorker },
      "run_command",
      { argv: ["echo", "hello-kur3"] },
    )) as { status: string; stdout: string; exitCode: number };
    assert.equal(r.status, "ok");
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /hello-kur3/);
  });

  it("refuses run_command when worker is disabled", async () => {
    const commandWorker = new DisabledCommandWorker();
    await assert.rejects(
      () =>
        executeTool(
          { fileWorker, commandWorker },
          "run_command",
          { argv: ["echo", "nope"] },
        ),
      /disabled|refused/,
    );
  });
});
