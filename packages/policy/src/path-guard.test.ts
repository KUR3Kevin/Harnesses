import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";
import { resolveWorkspacePath } from "./path-guard.js";

describe("resolveWorkspacePath", () => {
  let root: string;
  let outside: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kur3-ws-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "kur3-out-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), "ok");
    fs.writeFileSync(path.join(outside, "secret.txt"), "nope");
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("allows relative path inside root", () => {
    const r = resolveWorkspacePath(root, "src/a.ts");
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.relativePath, "src/a.ts");
  });

  it("blocks traversal with ..", () => {
    const r = resolveWorkspacePath(root, "../secret.txt");
    assert.equal(r.ok, false);
  });

  it("blocks absolute paths outside root", () => {
    const r = resolveWorkspacePath(root, path.join(outside, "secret.txt"));
    assert.equal(r.ok, false);
  });

  it("blocks symlink escape when supported", () => {
    const link = path.join(root, "escape-link");
    try {
      fs.symlinkSync(outside, link);
    } catch {
      // Some environments disallow symlinks; skip
      return;
    }
    const r = resolveWorkspacePath(root, "escape-link/secret.txt");
    assert.equal(r.ok, false);
    fs.unlinkSync(link);
  });
});
