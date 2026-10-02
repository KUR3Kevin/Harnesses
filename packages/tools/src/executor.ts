import type { CommandWorker, FileWorker } from "@kur3/worker";
import { RUN_COMMAND } from "./definitions.js";

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Invalid or missing string field: ${field}`);
  }
  return v;
}

function asArgv(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error("Invalid or missing argv: expected non-empty string array");
  }
  return v.map((part, i) => {
    if (typeof part !== "string" || part.length === 0) {
      throw new Error(`Invalid argv[${i}]: expected non-empty string`);
    }
    return part;
  });
}

export interface ToolExecutorDeps {
  fileWorker: FileWorker;
  commandWorker: CommandWorker;
  abortSignal?: AbortSignal;
}

/**
 * Execute a validated, policy-approved tool call against file + command workers.
 * Incomplete/partial JSON must never reach this function.
 * run_command is async and goes only through CommandWorker (never a host shell).
 */
export async function executeTool(
  deps: ToolExecutorDeps,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { fileWorker, commandWorker, abortSignal } = deps;

  switch (name) {
    case "read_file": {
      const p = asString(input.path, "path");
      return fileWorker.readFile(p);
    }
    case "search_files": {
      const pattern = asString(input.pattern, "pattern");
      const under =
        typeof input.under === "string" && input.under ? input.under : "src";
      return fileWorker.searchFiles(pattern, under);
    }
    case "propose_patch": {
      const p = asString(input.path, "path");
      const expectedHash = asString(input.expectedHash, "expectedHash");
      const newContent = asString(input.newContent, "newContent");
      return fileWorker.applyPatch(p, expectedHash, newContent, {
        proposeOnly: true,
      });
    }
    case "apply_patch": {
      const p = asString(input.path, "path");
      const expectedHash = asString(input.expectedHash, "expectedHash");
      const newContent = asString(input.newContent, "newContent");
      return fileWorker.applyPatch(p, expectedHash, newContent);
    }
    case "run_command": {
      if (commandWorker.isolationKind === "disabled") {
        throw new Error(
          "run_command refused: command worker is disabled (no unrestricted host-shell fallback). See ADR-0007.",
        );
      }
      const argv = asArgv(input.argv);
      const cwd =
        typeof input.cwd === "string" && input.cwd.length > 0
          ? input.cwd
          : undefined;
      const timeoutMs =
        typeof input.timeoutMs === "number" &&
        Number.isFinite(input.timeoutMs) &&
        input.timeoutMs > 0
          ? Math.min(input.timeoutMs, RUN_COMMAND.timeoutMs)
          : RUN_COMMAND.timeoutMs;
      const result = await commandWorker.run({
        argv,
        cwd,
        timeoutMs,
        abortSignal,
        maxStdoutBytes: RUN_COMMAND.outputLimitBytes,
        maxStderrBytes: RUN_COMMAND.outputLimitBytes,
      });
      return {
        status: result.canceled
          ? "canceled"
          : result.timedOut
            ? "timed_out"
            : "ok",
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        canceled: result.canceled,
        truncatedStdout: result.truncatedStdout,
        truncatedStderr: result.truncatedStderr,
      };
    }
    default:
      throw new Error(`No executor for tool: ${name}`);
  }
}
