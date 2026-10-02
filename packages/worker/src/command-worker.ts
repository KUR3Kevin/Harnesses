import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveWorkspacePath } from "@kur3/policy";

/** Default max captured stdout/stderr (bytes each). */
export const DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES = 256_000;

/** Default command timeout (ms). Guide §8 ordinary command default: 60s. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/**
 * Extra layer only — not isolation by itself (ADR-0007).
 * Basename of the executable must match when resolved.
 */
export const DEFAULT_COMMAND_ALLOWLIST: readonly string[] = [
  "node",
  "npm",
  "npx",
  "tsc",
  "git",
  "ls",
  "cat",
  "echo",
  "pwd",
  "true",
  "false",
  "sleep",
  "printf",
  "head",
  "tail",
  "wc",
  "rg",
  "grep",
  "find",
  "mkdir",
  "touch",
  "cp",
  "mv",
  "rm",
  "diff",
  "sort",
  "uniq",
  "tr",
  "tee",
  "test",
  "env",
  "basename",
  "dirname",
  "realpath",
  "which",
  "uname",
  "date",
  "id",
  "python3",
  "python",
  "make",
  "cargo",
  "go",
  "rustc",
  "bun",
  "yarn",
  "pnpm",
];

export interface CommandRunRequest {
  argv: string[];
  /** Relative to workspace root (default "."). Absolute paths must stay inside root. */
  cwd?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface CommandRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  canceled: boolean;
  truncatedStdout: boolean;
  truncatedStderr: boolean;
}

/**
 * Isolated (bounded) command execution boundary.
 * Implementations must NOT silently fall back to an unrestricted host shell.
 */
export interface CommandWorker {
  readonly backendId: string;
  readonly isolationKind: "bounded_subprocess" | "disabled";
  run(request: CommandRunRequest): Promise<CommandRunResult>;
}

export interface BoundedSubprocessCommandWorkerOptions {
  workspaceRoot: string;
  /** Extra env keys allowed through (values still taken only from allowlist build). */
  allowlist?: readonly string[];
  /** Override scrubbed PATH (default: system PATH). */
  pathEnv?: string;
}

function assertArgv(argv: unknown): string[] {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("run_command argv must be a non-empty string array");
  }
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const part = argv[i];
    if (typeof part !== "string" || part.length === 0) {
      throw new Error(`run_command argv[${i}] must be a non-empty string`);
    }
    if (part.includes("\0")) {
      throw new Error(`run_command argv[${i}] contains null byte`);
    }
    out.push(part);
  }
  return out;
}

function resolveBinary(
  command: string,
  workspaceRoot: string,
  cwd: string,
  pathEnv: string,
  allowlist: ReadonlySet<string>,
): string {
  // Absolute or relative path: must resolve inside workspace when it looks like a path
  if (command.includes("/") || command.includes(path.sep)) {
    const absolute = path.resolve(cwd, command);
    const relToRoot = path.relative(workspaceRoot, absolute);
    if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
      throw new Error(`Command path escapes workspace: ${command}`);
    }
    const resolved = resolveWorkspacePath(workspaceRoot, relToRoot);
    if (!resolved.ok) {
      throw new Error(resolved.reason);
    }
    if (!fs.existsSync(resolved.absolutePath)) {
      throw new Error(`Command not found in workspace: ${command}`);
    }
    const base = path.basename(resolved.absolutePath);
    if (!allowlist.has(base)) {
      throw new Error(
        `Command "${base}" is not on the allowlist (extra layer; see ADR-0007)`,
      );
    }
    return resolved.absolutePath;
  }

  if (!allowlist.has(command)) {
    throw new Error(
      `Command "${command}" is not on the allowlist (extra layer; see ADR-0007)`,
    );
  }

  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(`Command not found on PATH: ${command}`);
}

function buildScrubbedEnv(
  workspaceRoot: string,
  pathEnv: string,
): NodeJS.ProcessEnv {
  const home = path.join(workspaceRoot, ".kur3-command-home");
  const tmp = path.join(workspaceRoot, ".kur3-command-tmp");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  // Allowlist-only environment — never inherit host secrets / API keys / docker vars.
  return {
    PATH: pathEnv,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    TERM: "dumb",
    HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    KUR3_COMMAND_WORKER: "bounded_subprocess",
  };
}

function killProcessGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid == null) return;
  try {
    // Negative PID = process group (detached spawn creates a new group on POSIX).
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }
}

/**
 * POSIX bounded subprocess worker (Linux builder primary target).
 *
 * Boundaries (proven in tests): workspace cwd bind, path-guarded cwd,
 * allowlist-only env (no host secret inheritance), timeout, output caps,
 * process-group cancel/cleanup, no shell interpolation, optional binary allowlist.
 *
 * NOT a container/VM: the child shares the host filesystem namespace and can
 * still open absolute paths outside the workspace if it knows them. Do not
 * claim stronger isolation than this (ADR-0007). Harness DB and provider keys
 * must stay out of the workspace and out of the scrubbed env.
 */
export class BoundedSubprocessCommandWorker implements CommandWorker {
  readonly backendId = "bounded_subprocess_v1";
  readonly isolationKind = "bounded_subprocess" as const;

  private readonly root: string;
  private readonly allowlist: ReadonlySet<string>;
  private readonly pathEnv: string;

  constructor(options: BoundedSubprocessCommandWorkerOptions) {
    this.root = path.resolve(options.workspaceRoot);
    this.allowlist = new Set(options.allowlist ?? DEFAULT_COMMAND_ALLOWLIST);
    this.pathEnv = options.pathEnv ?? process.env.PATH ?? "/usr/bin:/bin";
  }

  get workspaceRoot(): string {
    return this.root;
  }

  async run(request: CommandRunRequest): Promise<CommandRunResult> {
    if (process.platform === "win32") {
      throw new Error(
        "BoundedSubprocessCommandWorker does not support win32; keep run_command disabled or use a documented backend",
      );
    }

    const argv = assertArgv(request.argv);
    const cwdInput = request.cwd && request.cwd.length > 0 ? request.cwd : ".";
    const cwdResolved = resolveWorkspacePath(this.root, cwdInput);
    if (!cwdResolved.ok) {
      throw new Error(cwdResolved.reason);
    }
    if (!fs.existsSync(cwdResolved.absolutePath)) {
      throw new Error(`cwd does not exist: ${cwdResolved.relativePath}`);
    }
    const cwdStat = fs.statSync(cwdResolved.absolutePath);
    if (!cwdStat.isDirectory()) {
      throw new Error(`cwd is not a directory: ${cwdResolved.relativePath}`);
    }

    const binary = resolveBinary(
      argv[0]!,
      this.root,
      cwdResolved.absolutePath,
      this.pathEnv,
      this.allowlist,
    );
    const args = argv.slice(1);
    const timeoutMs = request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const maxOut = request.maxStdoutBytes ?? DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES;
    const maxErr = request.maxStderrBytes ?? DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES;
    const env = buildScrubbedEnv(this.root, this.pathEnv);

    const signal = request.abortSignal;
    if (signal?.aborted) {
      return {
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        canceled: true,
        truncatedStdout: false,
        truncatedStderr: false,
      };
    }

    return await new Promise<CommandRunResult>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let canceled = false;
      let truncatedStdout = false;
      let truncatedStderr = false;
      let stdoutBuf = Buffer.alloc(0);
      let stderrBuf = Buffer.alloc(0);
      let timer: NodeJS.Timeout | undefined;
      let child: ChildProcess;

      const finish = (result: CommandRunResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };

      const onAbort = () => {
        canceled = true;
        killProcessGroup(child);
      };

      try {
        child = spawn(binary, args, {
          cwd: cwdResolved.absolutePath,
          env,
          argv0: path.basename(binary),
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
          shell: false,
          windowsHide: true,
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      signal?.addEventListener("abort", onAbort, { once: true });

      if (!child.stdout || !child.stderr) {
        killProcessGroup(child);
        reject(new Error("Failed to capture command stdio"));
        return;
      }

      child.stdout.on("data", (chunk: Buffer) => {
        if (truncatedStdout) return;
        const next = Buffer.concat([stdoutBuf, chunk]);
        if (next.length > maxOut) {
          stdoutBuf = next.subarray(0, maxOut);
          truncatedStdout = true;
          killProcessGroup(child);
        } else {
          stdoutBuf = next;
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        if (truncatedStderr) return;
        const next = Buffer.concat([stderrBuf, chunk]);
        if (next.length > maxErr) {
          stderrBuf = next.subarray(0, maxErr);
          truncatedStderr = true;
          killProcessGroup(child);
        } else {
          stderrBuf = next;
        }
      });

      timer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(child);
      }, timeoutMs);

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      child.on("close", (code) => {
        finish({
          exitCode: timedOut || canceled ? null : code,
          stdout: stdoutBuf.toString("utf8"),
          stderr: stderrBuf.toString("utf8"),
          timedOut,
          canceled,
          truncatedStdout,
          truncatedStderr,
        });
      });
    });
  }
}

/**
 * Explicit disabled backend — never silently falls back to host shell.
 * Manual path: operator runs the command in a terminal with cwd inside the workspace.
 */
export class DisabledCommandWorker implements CommandWorker {
  readonly backendId = "disabled";
  readonly isolationKind = "disabled" as const;

  async run(_request: CommandRunRequest): Promise<CommandRunResult> {
    throw new Error(
      "run_command is disabled: no isolated command backend is available on this OS/config. Manual path: run the command yourself in a terminal with cwd inside the workspace root. See ADR-0007.",
    );
  }
}

/** Select a command backend for the current platform without unrestricted fallback. */
export function createCommandWorker(options: {
  workspaceRoot: string;
  allowlist?: readonly string[];
}): CommandWorker {
  if (process.platform === "linux" || process.platform === "darwin") {
    return new BoundedSubprocessCommandWorker(options);
  }
  return new DisabledCommandWorker();
}
