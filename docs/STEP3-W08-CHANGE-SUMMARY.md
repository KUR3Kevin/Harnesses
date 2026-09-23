# Step 3 / W08 change summary (for Kevin)

Date: 2026-09-23 (PT)  
Repo: `/workspace/Harnesses` (GitHub: KUR3Kevin/Harnesses)  
Branch: `step3/w08-isolated-worker` (from main `e998ed6d9019d939194a49ee5c674ad5abbe09cf`)  
Feature commit: *(filled after commit)*  
Branch tip: `git rev-parse step3/w08-isolated-worker` (local only; not pushed)  
Scope: Master Build Guide work package **W08 only** — isolated command worker  
**Not pushed / not merged.** No W09+.

## Cut / scope (explicit)

| In W08 | Out of scope |
| --- | --- |
| ADR-0007 backend choice (bounded subprocess) | Docker / bwrap backends (not available here) |
| `CommandWorker` + process-group cancel/timeout | W09 recovery / budget |
| `run_command` tool + Run-mode policy via isolated path | W10 second provider |
| Containment / env / truncation tests | Claiming full FS or network sandbox |
| Docs: STATUS, handoff, this summary | Push / merge / PR |

## What landed

### Worker (`packages/worker`)
- `CommandWorker` interface: `run({ argv, cwd?, timeoutMs, abortSignal, … })`
- `BoundedSubprocessCommandWorker` — cwd bind, scrubbed env, timeout, output caps, process-group kill, binary allowlist (extra)
- `DisabledCommandWorker` + `createCommandWorker()` (no unrestricted fallback)
- Tests: cwd escape reject, env non-leak, timeout, abort cancel, stdout truncation, allowlist

### Tools (`packages/tools`)
- `RUN_COMMAND` definition (`effect: "external"`)
- Async `executeTool({ fileWorker, commandWorker, abortSignal }, …)` — `run_command` only via CommandWorker

### Policy (`packages/policy`)
- Removed hard “disabled until W08” deny
- Plan mode still denies `run_command`
- Run mode allows only when `commandWorkerEnabled: true`

### Core (`packages/core`)
- `HarnessRuntime` wires `createCommandWorker` and passes `commandWorkerEnabled` + abort signal

### Docs
- `docs/decisions/ADR-0007-command-worker-backend.md`
- `docs/handoffs/W08-handoff.md`
- `docs/STATUS.md` — W08 → ready for review
- this file; README + ADR-0004 isolation line updated

## Why
Guide W08 exit: command containment and cancel on supported OS. Docker/`bwrap` absent on the builder → documented bounded subprocess (ADR-0007) rather than silent host shell.

## How to run

```bash
cd /workspace/Harnesses
npm run build
npm run typecheck
npm test
npm run demo:offline
npm run demo:extension-offline
```

## Commands that passed (this session)

| Command | Result |
| --- | --- |
| `npm run build` | *(filled after verify)* |
| `npm run typecheck` | *(filled after verify)* |
| `npm test` | *(filled after verify)* |
| `npm run demo:offline` | *(filled after verify)* |
| `npm run demo:extension-offline` | *(filled after verify)* |

Environment: Linux x86_64, Node v20.19.2, npm 9.2.0.

## Residual / FLAGs

1. **FLAG — not a container:** Child shares host FS/network namespaces. Absolute host paths are still reachable if the command opens them. Do not market as a full sandbox.
2. **FLAG — no network deny list:** A17 “network destinations” not enforced at OS level.
3. **FLAG — binary allowlist is extra only:** Bypass via allowlisted interpreters (`node -e`, etc.) is expected; boundaries are cwd/env/timeout/caps/cancel.
4. **FLAG — Windows:** `createCommandWorker` returns disabled on non-POSIX; no win32 backend in W08.
5. **W06/W07 preserved:** FakeProvider + `demo:offline` + `demo:extension-offline` must stay green; no provider/bridge contract breaks intended.

## Confirm
- Scope: **W08 only**
- **Not pushed. Not merged. No PR.**
- No W09+ work.
