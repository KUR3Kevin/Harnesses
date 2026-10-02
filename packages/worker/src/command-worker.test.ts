import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  BoundedSubprocessCommandWorker,
  DisabledCommandWorker,
  createCommandWorker,
} from "./command-worker.js";

describe("BoundedSubprocessCommandWorker", () => {
  let root: string;
  let worker: BoundedSubprocessCommandWorker;
  let plantedSecret: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kur3-cw-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "note.txt"), "inside-workspace\n");
    // Secret outside workspace (simulates harness DB / keys location)
    fs.writeFileSync(
      path.join(os.tmpdir(), `kur3-secret-${path.basename(root)}.txt`),
      "SUPER_SECRET_VALUE\n",
    );
    plantedSecret = process.env.KUR3_PLANTED_API_KEY;
    process.env.KUR3_PLANTED_API_KEY = "should-never-leak-to-child";
    process.env.OPENAI_API_KEY = "sk-planted-openai";
    worker = new BoundedSubprocessCommandWorker({ workspaceRoot: root });
  });

  afterEach(() => {
    if (plantedSecret === undefined) {
      delete process.env.KUR3_PLANTED_API_KEY;
    } else {
      process.env.KUR3_PLANTED_API_KEY = plantedSecret;
    }
    delete process.env.OPENAI_API_KEY;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("runs a simple argv command with workspace cwd", async () => {
    const r = await worker.run({ argv: ["pwd"] });
    assert.equal(r.canceled, false);
    assert.equal(r.timedOut, false);
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), root);
  });

  it("rejects cwd that escapes the workspace", async () => {
    await assert.rejects(
      () => worker.run({ argv: ["pwd"], cwd: ".." }),
      /escapes workspace|Path escapes/,
    );
  });

  it("rejects absolute cwd outside workspace", async () => {
    await assert.rejects(
      () => worker.run({ argv: ["pwd"], cwd: "/tmp" }),
      /escapes workspace|Path escapes/,
    );
  });

  it("does not leak planted host secrets into child env", async () => {
    const r = await worker.run({
      argv: [
        "node",
        "-e",
        "process.stdout.write(JSON.stringify({k:process.env.KUR3_PLANTED_API_KEY||null,o:process.env.OPENAI_API_KEY||null,w:process.env.KUR3_COMMAND_WORKER||null}))",
      ],
    });
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout) as {
      k: string | null;
      o: string | null;
      w: string | null;
    };
    assert.equal(parsed.k, null);
    assert.equal(parsed.o, null);
    assert.equal(parsed.w, "bounded_subprocess");
  });

  it("times out and kills the process group", async () => {
    const started = Date.now();
    const r = await worker.run({
      argv: [
        "node",
        "-e",
        "setInterval(() => {}, 1000);",
      ],
      timeoutMs: 200,
    });
    const elapsed = Date.now() - started;
    assert.equal(r.timedOut, true);
    assert.equal(r.canceled, false);
    assert.equal(r.exitCode, null);
    assert.ok(elapsed < 5000, `timeout cleanup too slow: ${elapsed}ms`);
  });

  it("cancel via AbortSignal kills the child", async () => {
    const ac = new AbortController();
    const pending = worker.run({
      argv: [
        "node",
        "-e",
        "setInterval(() => {}, 1000);",
      ],
      timeoutMs: 30_000,
      abortSignal: ac.signal,
    });
    setTimeout(() => ac.abort(), 100);
    const r = await pending;
    assert.equal(r.canceled, true);
    assert.equal(r.timedOut, false);
    assert.equal(r.exitCode, null);
  });

  it("truncates oversized stdout and stops the child", async () => {
    const r = await worker.run({
      argv: [
        "node",
        "-e",
        "process.stdout.write('x'.repeat(50_000))",
      ],
      maxStdoutBytes: 1024,
      timeoutMs: 10_000,
    });
    assert.equal(r.truncatedStdout, true);
    assert.ok(Buffer.byteLength(r.stdout, "utf8") <= 1024);
  });

  it("rejects non-allowlisted binary", async () => {
    await assert.rejects(
      () => worker.run({ argv: ["nonexistent_kur3_bin_zzz"] }),
      /allowlist/,
    );
  });

  it("rejects command path escape via argv0", async () => {
    await assert.rejects(
      () => worker.run({ argv: ["../outside-bin"] }),
      /escapes workspace|allowlist|not found/,
    );
  });

  it("can read a file inside workspace via relative cwd", async () => {
    const r = await worker.run({
      argv: ["cat", "note.txt"],
      cwd: "src",
    });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /inside-workspace/);
  });
});

describe("DisabledCommandWorker / createCommandWorker", () => {
  it("DisabledCommandWorker refuses to run (no unrestricted fallback)", async () => {
    const d = new DisabledCommandWorker();
    await assert.rejects(() => d.run({ argv: ["echo", "hi"] }), /disabled/);
  });

  it("createCommandWorker returns bounded backend on this OS", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kur3-cw-create-"));
    try {
      const w = createCommandWorker({ workspaceRoot: root });
      assert.equal(w.isolationKind, "bounded_subprocess");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
