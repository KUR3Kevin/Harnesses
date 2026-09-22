import fs from "node:fs";
import path from "node:path";
import { resolveWorkspacePath } from "@kur3/policy";
import { contentHash } from "./hash.js";

export interface FileWorkerOptions {
  workspaceRoot: string;
}

export type FileReadResult =
  | {
      status: "ok";
      path: string;
      content: string;
      hash: string;
      bytes: number;
    }
  | { status: "error"; error: string };

export type FileSearchHit = { path: string; line: number; text: string };

export type PatchResult =
  | {
      status: "applied" | "proposed";
      path: string;
      previousHash: string;
      newHash: string;
    }
  | { status: "conflict"; path: string; actualHash: string; expectedHash: string }
  | { status: "error"; error: string };

/**
 * File operations within the declared workspace boundary.
 * This is NOT a sandbox — it is a path-checked process boundary for the
 * offline / file-edit prototype stages (guide §10).
 */
export class FileWorker {
  private readonly root: string;

  constructor(options: FileWorkerOptions) {
    this.root = path.resolve(options.workspaceRoot);
  }

  get workspaceRoot(): string {
    return this.root;
  }

  readFile(userPath: string): FileReadResult {
    const resolved = resolveWorkspacePath(this.root, userPath);
    if (!resolved.ok) {
      return { status: "error", error: resolved.reason };
    }
    if (!fs.existsSync(resolved.absolutePath)) {
      return {
        status: "error",
        error: `File not found: ${resolved.relativePath}`,
      };
    }
    const content = fs.readFileSync(resolved.absolutePath, "utf8");
    return {
      status: "ok",
      path: resolved.relativePath,
      content,
      hash: contentHash(content),
      bytes: Buffer.byteLength(content, "utf8"),
    };
  }

  searchFiles(
    pattern: string,
    globHint = "src",
  ): { status: "ok"; hits: FileSearchHit[] } | { status: "error"; error: string } {
    if (!pattern) {
      return { status: "error", error: "pattern is required" };
    }
    const base = resolveWorkspacePath(this.root, globHint);
    if (!base.ok) {
      return { status: "error", error: base.reason };
    }
    const hits: FileSearchHit[] = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(this.root, full).split(path.sep).join("/");
        // Re-validate each path
        const check = resolveWorkspacePath(this.root, rel);
        if (!check.ok) continue;
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const text = fs.readFileSync(full, "utf8");
          const lines = text.split(/\r?\n/);
          lines.forEach((line, i) => {
            if (line.includes(pattern)) {
              hits.push({ path: rel, line: i + 1, text: line.slice(0, 200) });
            }
          });
        }
      }
    };
    walk(base.absolutePath);
    return { status: "ok", hits };
  }

  applyPatch(
    userPath: string,
    expectedHash: string,
    newContent: string,
    { proposeOnly = false } = {},
  ): PatchResult {
    const resolved = resolveWorkspacePath(this.root, userPath);
    if (!resolved.ok) {
      return { status: "error", error: resolved.reason };
    }

    let previousHash = contentHash("");
    if (fs.existsSync(resolved.absolutePath)) {
      const current = fs.readFileSync(resolved.absolutePath);
      previousHash = contentHash(current);
      if (expectedHash !== "unknown" && previousHash !== expectedHash) {
        return {
          status: "conflict",
          path: resolved.relativePath,
          actualHash: previousHash,
          expectedHash,
        };
      }
    } else if (expectedHash !== "unknown" && expectedHash !== contentHash("")) {
      return {
        status: "conflict",
        path: resolved.relativePath,
        actualHash: contentHash(""),
        expectedHash,
      };
    }

    if (proposeOnly) {
      return {
        status: "proposed",
        path: resolved.relativePath,
        previousHash,
        newHash: contentHash(newContent),
      };
    }

    fs.mkdirSync(path.dirname(resolved.absolutePath), { recursive: true });
    fs.writeFileSync(resolved.absolutePath, newContent, "utf8");
    return {
      status: "applied",
      path: resolved.relativePath,
      previousHash,
      newHash: contentHash(newContent),
    };
  }
}
