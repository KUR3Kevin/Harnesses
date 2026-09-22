import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export interface HostClientOptions {
  hostEntry: string;
  cwd: string;
  nodePath?: string;
  nodeArgs?: string[];
}

/**
 * Stdio JSON-lines client to bridge-host-main.
 */
export class BridgeHostClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >;
  private starting: Promise<void> | null = null;

  constructor(private readonly options: HostClientOptions) {}

  async start(): Promise<void> {
    if (this.proc) return;
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      const node = this.options.nodePath ?? process.execPath;
      const args = [...(this.options.nodeArgs ?? []), this.options.hostEntry];
      const proc = spawn(node, args, {
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
      this.proc = proc;
      this.rl = readline.createInterface({ input: proc.stdout });
      this.rl.on("line", (line) => {
        try {
          const msg = JSON.parse(line) as { requestId?: string };
          const id = msg.requestId;
          if (id && this.pending.has(id)) {
            this.pending.get(id)!.resolve(msg);
            this.pending.delete(id);
          }
        } catch {
          /* ignore */
        }
      });
      proc.stderr.on("data", (buf: Buffer) => {
        process.stderr.write(buf);
      });
      proc.on("error", (err) => done(err));
      proc.on("spawn", () => done());
      if (proc.pid) done();
    });
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async request(body: Record<string, unknown>): Promise<unknown> {
    await this.start();
    if (!this.proc?.stdin) throw new Error("Bridge host not started");
    const requestId = String(body.requestId ?? `req-${Date.now()}`);
    const payload = { ...body, requestId };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Bridge host timeout for ${requestId}`));
      }, 60_000);
      this.pending.set(requestId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc!.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  async dispose(): Promise<void> {
    for (const [, p] of this.pending) {
      p.reject(new Error("Bridge host disposed"));
    }
    this.pending.clear();
    this.rl?.close();
    this.rl = null;
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }
}

export function defaultHostPaths(fromMetaUrl: string): {
  hostEntry: string;
  cwd: string;
  nodeArgs: string[];
} {
  const here = path.dirname(fileURLToPath(fromMetaUrl));
  const cwd = path.resolve(here, "../../..");
  const candidates = [
    path.resolve(here, "bridge-host-main.js"),
    path.resolve(here, "bridge-host-main.ts"),
    path.resolve(here, "../src/bridge-host-main.ts"),
  ];
  for (const hostEntry of candidates) {
    if (!fs.existsSync(hostEntry)) continue;
    if (hostEntry.endsWith(".ts")) {
      return { hostEntry, cwd, nodeArgs: ["--import", "tsx"] };
    }
    return { hostEntry, cwd, nodeArgs: [] };
  }
  throw new Error("bridge-host-main entry not found");
}
