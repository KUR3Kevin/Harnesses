Task ID: W09 (Step 3 — recovery and budget hardening)
Builder/model as reported by the interface: Grok Bot (executor subagent)
Date: 2026-10-02 (America/Los_Angeles)
Base commit or supplied source snapshot: main `91f4c1057023a7d4555c6e492fbf8550c9f2718c`
Resulting commit or patch reference: feature `a83c827e8ab6d53a3bf6b5e18083fd4a42578d76` on `step3/w09-recovery-budget` (docs commit follows; not pushed)

Objective:
Deliver Master Build Guide W09 only: unknown-outcome reconciliation, budget reservations, export handoff. Crash and retry fixtures must not blindly duplicate writes.

Files changed:
- packages/contracts (budget, handoff, tool-call fields, events, bridge commands)
- packages/storage (tool calls, lease reload)
- packages/worker (`inspectHash`)
- packages/core (recovery, budget, handoff, runtime, bridge)
- docs/decisions/ADR-0008-recovery-and-budget.md
- docs/STATUS.md, docs/STEP3-W09-CHANGE-SUMMARY.md, this handoff
- README.md status line

Interfaces changed (additive):
- `resume_run`, `export_handoff` on the bridge (protocol version still 0.1.0)
- `HarnessRuntime.resumeRun`, `raiseEstimatedSpendingLimit`, `exportHandoff`
- Optional `Run.budget`, `RunLimits.estimatedSpendingLimitUsd`, `RunLimits.maxOutputTokens`
- `ModelProvider` unchanged

Decisions and reasons:
- See ADR-0008

Checks actually executed:
- Command: npm run build — success
- Command: npm run typecheck — success
- Command: npm test — success (includes A11/A12/A13 fixtures and export redaction)
- Command: npm run demo:offline — DEMO OK (offline)
- Command: npm run demo:extension-offline — DEMO EXTENSION-OFFLINE OK
Environment: Linux x86_64, Node v20.19.2, npm 9.2.0

Checks not executed and why:
- Live provider billing — forbidden (no paid API)
- Torn-write / power-loss disk image — not claimed
- W10 provider switch — out of scope

Acceptance IDs (local fixtures only):
- A11 crash during write: post-hash skip, pre-hash single retry, conflict no overwrite
- A12 duplicate resume: second holder cannot take an unexpired lease
- A13 budget: reservation before stream; insufficient and unknown quotes block; unknown usage not labeled 0
- export_handoff: facts, artifact refs, remaining work, secrets redacted
Not claimed: full A01–A20

Known limitations:
- See FLAGs in docs/STEP3-W09-CHANGE-SUMMARY.md and ADR-0008

Uncommitted or conflicting work:
- Ignore untracked `Harnesses-w07/` if present

Remaining tasks:
- Kevin reviews ADR-0008 and the spending-limit wording
- Optional later: journaled writes, provider idempotency keys, real price table

Exact next action:
Kevin reviews `docs/STEP3-W09-CHANGE-SUMMARY.md` and ADR-0008.

Files the next model needs:
- docs/STEP3-W09-CHANGE-SUMMARY.md
- docs/decisions/ADR-0008-recovery-and-budget.md
- packages/core/src/recovery.ts, packages/core/src/budget.ts, packages/core/src/runtime.ts
