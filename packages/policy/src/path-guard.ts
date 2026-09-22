import path from "node:path";
import fs from "node:fs";

export type PathResolution =
  | { ok: true; absolutePath: string; relativePath: string }
  | { ok: false; reason: string };

/**
 * Resolve a user-supplied path against a canonical workspace root.
 * Blocks traversal and symlink escapes outside the root.
 */
export function resolveWorkspacePath(
  workspaceRoot: string,
  userPath: string,
): PathResolution {
  if (!userPath || typeof userPath !== "string") {
    return { ok: false, reason: "Path is required" };
  }
  if (userPath.includes("\0")) {
    return { ok: false, reason: "Path contains null byte" };
  }

  const rootReal = fs.existsSync(workspaceRoot)
    ? fs.realpathSync(workspaceRoot)
    : path.resolve(workspaceRoot);

  const candidate = path.resolve(rootReal, userPath);

  // Lexical containment check before symlink resolution
  const rel = path.relative(rootReal, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return {
      ok: false,
      reason: `Path escapes workspace root: ${userPath}`,
    };
  }

  // If the path (or a parent) exists, resolve symlinks and re-check
  let checkPath = candidate;
  while (
    !fs.existsSync(checkPath) &&
    checkPath !== rootReal &&
    checkPath !== path.dirname(checkPath)
  ) {
    checkPath = path.dirname(checkPath);
  }

  if (fs.existsSync(checkPath)) {
    const real = fs.realpathSync(checkPath);
    const realRel = path.relative(rootReal, real);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
      return {
        ok: false,
        reason: `Symlink or resolved path escapes workspace: ${userPath}`,
      };
    }
  }

  return {
    ok: true,
    absolutePath: candidate,
    relativePath: rel.split(path.sep).join("/"),
  };
}
