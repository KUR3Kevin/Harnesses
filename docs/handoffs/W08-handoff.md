Task ID: W08 (Step 3 — isolated command worker)
Builder/model as reported by the interface: Grok Bot (executor subagent)
Date: 2026-09-23 (America/Los_Angeles)
Base commit or supplied source snapshot: main `e998ed6d9019d939194a49ee5c674ad5abbe09cf`
Resulting commit or patch reference: `28cd7be0cb3774a8af0816835769cea30b8cf172` on branch `step3/w08-isolated-worker` (local only; not pushed)

Objective:
Deliver Master Build Guide W08 only: choose command isolation backend for this OS, environment boundary, process cleanup; demonstrate containment and cancel; enable `run_command` only through the isolated path.

Files changed:
- packages/worker (CommandWorker + tests)
- packages/tools (RUN_COMMAND + async executor)
- packages/policy (commandWorkerEnabled; Plan still blocks)
- packages/core (runtime wiring)
- docs/decisions/ADR-0007, docs/STATUS.md, docs/STEP3-W08-CHANGE-SUMMARY.md, this handoff
- README.md, docs/decisions/ADR-0004 (isolation stage line)

Interfaces changed:
- New `CommandWorker` API in `@kur3/worker`
- `executeTool` now async with `ToolExecutorDeps`
- PolicyContext.`commandWorkerEnabled`
- Tool registry includes `run_command`

Decisions and reasons:
- See ADR-0007 (bounded subprocess; Docker/bwrap unavailable; no unrestricted fallback)

Checks actually executed:
- Command: npm run build — success
- Command: npm run typecheck — success
- Command: npm test — success (unit + IPC + integration; CommandWorker containment/cancel/timeout/env)
- Command: npm run demo:offline — DEMO OK (offline)
- Command: npm run demo:extension-offline — DEMO EXTENSION-OFFLINE OK
Environment: Linux x86_64, Node v20.19.2, npm 9.2.0

Checks not executed and why:
- Docker/`bwrap` isolation proof — tools not installed on builder
- Windows command backend — out of W08 cut
- Full A17 network deny — not claimed

Acceptance IDs (partial / local evidence only):
- A03-ish: Plan mode denies run_command (policy tests)
- A10-ish: AbortSignal cancel kills process group (worker tests)
- A17-partial: cwd escape blocked; planted env secrets not inherited; NOT full FS/network sandbox
Not claimed: full A01–A20

Known limitations:
- See FLAGs in STEP3-W08-CHANGE-SUMMARY.md / ADR-0007

Uncommitted or conflicting work:
- Ignore untracked `Harnesses-w07/` directory if present (prior worktree leftover)

Remaining tasks:
- Kevin review of ADR-0007 and isolation FLAGs
- Optional later: container/`bwrap` backend when available

Exact next action:
Kevin reviews `docs/STEP3-W08-CHANGE-SUMMARY.md` and ADR-0007.

Files the next model needs:
- docs/STEP3-W08-CHANGE-SUMMARY.md, docs/decisions/ADR-0007-command-worker-backend.md
- packages/worker/src/command-worker.ts, packages/tools/src/executor.ts, packages/policy/src/policy-engine.ts
