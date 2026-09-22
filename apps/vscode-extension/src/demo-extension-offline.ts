/**
 * Entry used by `npm run demo:extension-offline`.
 * Delegates to bridge-host-main --once-offline (same path the extension IPC uses).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const host = path.join(here, "bridge-host-main.ts");

const child = spawn(
  process.execPath,
  ["--import", "tsx", host, "--once-offline"],
  { stdio: "inherit", cwd: path.resolve(here, "../../..") },
);

child.on("exit", (code) => process.exit(code ?? 1));
