import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { FileWorker } from "./file-worker.js";
import { contentHash } from "./hash.js";

describe("FileWorker", () => {
  let root: string;
  let worker: FileWorker;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kur3-fw-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src", "hello.ts"),
      'export function hello(): string {\n  return "hello";\n}\n',
    );
    worker = new FileWorker({ workspaceRoot: root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads file with hash", () => {
    const r = worker.readFile("src/hello.ts");
    assert.equal(r.status, "ok");
    if (r.status === "ok") {
      assert.match(r.content, /hello/);
      assert.equal(r.hash.length, 64);
    }
  });

  it("applies patch when hash matches", () => {
    const read = worker.readFile("src/hello.ts");
    assert.equal(read.status, "ok");
    if (read.status !== "ok") return;
    const next = read.content.replace('"hello"', '"hello, kur3"');
    const patch = worker.applyPatch("src/hello.ts", read.hash, next);
    assert.equal(patch.status, "applied");
    const again = worker.readFile("src/hello.ts");
    assert.equal(again.status, "ok");
    if (again.status === "ok") assert.match(again.content, /hello, kur3/);
  });

  it("conflicts on stale hash", () => {
    const read = worker.readFile("src/hello.ts");
    assert.equal(read.status, "ok");
    if (read.status !== "ok") return;
    fs.writeFileSync(path.join(root, "src", "hello.ts"), "changed by user\n");
    const patch = worker.applyPatch(
      "src/hello.ts",
      read.hash,
      "new\n",
    );
    assert.equal(patch.status, "conflict");
    assert.equal(
      fs.readFileSync(path.join(root, "src", "hello.ts"), "utf8"),
      "changed by user\n",
    );
  });

  it("blocks path traversal", () => {
    const r = worker.readFile("../outside.txt");
    assert.equal(r.status, "error");
  });

  it("contentHash is stable", () => {
    assert.equal(contentHash("a"), contentHash("a"));
    assert.notEqual(contentHash("a"), contentHash("b"));
  });
});
