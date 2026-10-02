# ADR-0007: Isolated command worker backend (W08)

Decision ID and date: ADR-0007 / 2026-09-23  
Question: Which command isolation backend should KUR3 use on the current supported builder OS, without silently falling back to an unrestricted host shell?

## Options considered
1. **Docker / container worker** — bind-mount workspace only; drop docker.sock; network none
2. **bubblewrap (`bwrap`) user-namespace sandbox** — bind workspace; unshare net/pid
3. **Bounded subprocess worker** — `spawn` with `shell:false`, workspace cwd, scrubbed allowlist-only env, timeout, output caps, process-group kill on cancel/timeout, optional binary allowlist; no unrestricted fallback
4. **Keep `run_command` fully disabled** — manual terminal only

## Chosen option or provisional default
**Option 3 (provisional): Bounded subprocess worker on Linux/macOS (`BoundedSubprocessCommandWorker`).**

Evidence from this builder (2026-09-23 PT):
- OS: Linux x86_64, Node v20.19.2
- `docker` / `bwrap`: **not available**
- User-namespace `unshare` works in a probe, but was **not** adopted as the product backend for W08 (extra moving parts; not required when guide allows a documented bounded subprocess)

`createCommandWorker()` selects bounded subprocess on `linux`/`darwin`. On unsupported platforms it returns `DisabledCommandWorker` (clear error + manual path) — **never** an unrestricted shell.

## Boundaries implemented (and tested)
| Boundary | Behavior |
| --- | --- |
| cwd / workspace root | `resolveWorkspacePath`; reject `..` and absolute escapes |
| No shell | `spawn(..., { shell: false })` with argv array only |
| Env scrubbing | Allowlist-only env; does not inherit `OPENAI_API_KEY` / planted secrets; `HOME`/`TMPDIR` under workspace |
| Timeout | Kills process **group** (`detached` + `kill(-pid)`) |
| Cancel | `AbortSignal` → same process-group kill |
| Output caps | Truncate stdout/stderr bytes; kill child when exceeded |
| Binary allowlist | Extra layer only (not sufficient isolation by itself) |
| Harness DB / keys / docker.sock | Not passed in env; docker.sock absent on builder; DB lives in runtime `dataDir` (keep outside workspace) |

## What this is NOT
- **Not a container or VM.** The child shares the host filesystem/network namespaces. A command that opens an absolute host path (e.g. `/etc/passwd`) is not blocked by cwd alone.
- **Not network isolation.** Outbound network is still possible from the child.
- Allowlist alone ≠ isolation (guide §10) — hence cwd/env/timeout/caps/cancel remain mandatory.

## Manual path when disabled
If `DisabledCommandWorker` is active: operator runs the intended command in a terminal with cwd inside the workspace root. Policy continues to deny `run_command` when `commandWorkerEnabled` is false.

## Tradeoffs
- Ships W08 exit criteria (containment of cwd tricks, cancel, timeout, env non-leak) offline without Docker.
- Residual risk: host FS/network reachability — FLAG for a later container/`bwrap` revisit when available and proven in CI.

## Affected contracts and modules
`packages/worker` (`CommandWorker`), `packages/tools` (`run_command`), `packages/policy` (`commandWorkerEnabled`), `packages/core` (`HarnessRuntime`).

## Revisit trigger
- Docker or `bwrap` available in CI and proven offline
- Need for A17-strength “denied files / network destinations” beyond env+cwd bounds
- Windows support requirement

## Owner decision required, if any
Confirm whether a container backend is required before claiming production-grade sandboxing. W08 provisional default is bounded subprocess on Linux/macOS.
