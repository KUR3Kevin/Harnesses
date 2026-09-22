import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { FileWorker } from "@kur3/worker";
import { executeTool } from "./executor.js";

describe("executeTool", () => {
  let root: string;
  let worker: FileWorker;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kur3-tool-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), " const x = 1;\n");
    worker = new FileWorker({ workspaceRoot: root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads via read_file", () => {
    const r = executeTool(worker, "read_file", { path: "src/a.ts" }) as {
      status: string;
    };
    assert.equal(r.status, "ok");
  });

  it("rejects missing path", () => {
    assert.throws(() => executeTool(worker, "read_file", {}));
  });
});
