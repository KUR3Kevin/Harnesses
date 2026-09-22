import type { FileWorker } from "@kur3/worker";

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Invalid or missing string field: ${field}`);
  }
  return v;
}

/**
 * Execute a validated, policy-approved tool call against the file worker.
 * Incomplete/partial JSON must never reach this function.
 */
export function executeTool(
  worker: FileWorker,
  name: string,
  input: Record<string, unknown>,
): unknown {
  switch (name) {
    case "read_file": {
      const p = asString(input.path, "path");
      return worker.readFile(p);
    }
    case "search_files": {
      const pattern = asString(input.pattern, "pattern");
      const under =
        typeof input.under === "string" && input.under ? input.under : "src";
      return worker.searchFiles(pattern, under);
    }
    case "propose_patch": {
      const p = asString(input.path, "path");
      const expectedHash = asString(input.expectedHash, "expectedHash");
      const newContent = asString(input.newContent, "newContent");
      return worker.applyPatch(p, expectedHash, newContent, {
        proposeOnly: true,
      });
    }
    case "apply_patch": {
      const p = asString(input.path, "path");
      const expectedHash = asString(input.expectedHash, "expectedHash");
      const newContent = asString(input.newContent, "newContent");
      return worker.applyPatch(p, expectedHash, newContent);
    }
    default:
      throw new Error(`No executor for tool: ${name}`);
  }
}
