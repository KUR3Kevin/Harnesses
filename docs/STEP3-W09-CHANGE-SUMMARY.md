# Step 3 / W09 change summary (for Kevin)

Date: 2026-10-02 (PT)  
Repo: `/workspace/Harnesses` (GitHub: KUR3Kevin/Harnesses)  
Branch: `step3/w09-recovery-budget` (from main `91f4c1057023a7d4555c6e492fbf8550c9f2718c`, includes merged W08 PR #5)  
Feature commit: `a83c827e8ab6d53a3bf6b5e18083fd4a42578d76`  
Branch tip: `git rev-parse HEAD` on `step3/w09-recovery-budget` (docs commit on top of the feature commit; local only; not pushed)  
Scope: Master Build Guide work package **W09 only** — recovery and budget hardening  
**Not pushed / not merged.** No W10+.

## Cut / scope (explicit)

| In W09 | Out of scope |
| --- | --- |
| Unknown-outcome reconciliation via pre/post file hashes | Write-ahead journal / torn-sector recovery |
| Run lease reload; duplicate resume rejected | Stealing an unexpired lease |
| Reserve estimated input + max output **before** the provider call; reconcile after | A guaranteed provider billing cap |
| Unknown price or usage labeled `unknown`, never coerced to 0 | Live paid API, price catalog from a vendor |
| `budget_exhausted` blocks new billable work until an explicit limit raise | Auto-continuing external mutations |
| `export_handoff` facts, artifact refs, remaining work, redaction | Claiming the redactor finds every secret |
| ADR-0008, STATUS, this summary, handoff | W10 second provider, push, merge |

## What landed

### Contracts
- `BudgetSnapshot`, price table, `ESTIMATED_SPENDING_LIMIT_NOTE`
- Optional run limits: `estimatedSpendingLimitUsd`, `maxOutputTokens`
- Tool-call fields: effect, `safeRetry`, `mutates`, expected pre/post hashes, reconciliation
- Events: `tool_outcome_unknown`, `budget_reserved`, `budget_reconciled`, `budget_limit_raised`, `run_interrupted`
- `Handoff` schema
- Bridge commands `resume_run` and `export_handoff` (additive; protocol version unchanged). Error code `lease_held`

### Storage
- Tool calls persisted beside runs
- `acquireLease` / `releaseLease` reload from disk so another process's lease is visible

### Worker
- `FileWorker.inspectHash` reads bytes and does not write

### Core
- `planRecoveryAction` / `reconcileToolCall`: post-hash → skip write; pre-hash → one apply; mismatch → conflict; external → no retry; read retries only if `safeRetry`
- Budget quote, reserve-before-stream, reconcile, dangling-reservation hold
- `HarnessRuntime.resumeRun`, `raiseEstimatedSpendingLimit`, `exportHandoff`
- Bridge wires the two new commands

### Behavior preserved
- FakeProvider / `demo:offline` / `demo:extension-offline` have **no** spending limit, so they are not budget-blocked
- W06 `ModelProvider` surface unchanged
- W08 `CommandWorker` path unchanged; `run_command` is not auto-retried

## Why
Guide W09 exit: crash and retry fixtures pass without blind duplicate writes. Unknown cost must not look like zero, and a reservation the remaining estimate cannot cover must not start another request.

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
| `npm run build` | **pass** (`tsc -b`, clean rebuild) |
| `npm run typecheck` | **pass** |
| `npm test` | **pass** — contracts, core (including W09 fixtures), policy, providers, storage, tools, worker, vscode IPC, integration |
| `npm run demo:offline` | **pass** — `DEMO OK (offline)` |
| `npm run demo:extension-offline` | **pass** — `DEMO EXTENSION-OFFLINE OK` |

Environment: Linux x86_64, Node v20.19.2, npm 9.2.0. No live provider calls.

### Fixtures actually run
- A11 post-hash: 0 writes, bytes unchanged; second resume does not write
- A11 pre-hash: exactly one `applyPatch`, then a second resume writes 0
- A11 conflict: 0 writes, unexpected bytes kept
- A12: second runtime `resumeRun` fails while the first holder’s lease is unexpired
- A13: insufficient reservation → `budget_exhausted`, provider `stream` not called
- A13: `reservedUsd > 0` observed in `store.json` **during** `stream`, before reconcile
- A13: reported usage above the estimate is recorded and the **next** request is blocked
- A13: missing usage → `costLabel: "unknown"`, `estimatedCostUsd` omitted (not 0); `formatSpend` is `unknown`
- A13: prices omitted under a configured limit → request refused (not treated as $0)
- A13: `resume` while `budget_exhausted` does not stream until `raiseEstimatedSpendingLimit`
- `export_handoff`: no `SECRETVALUE` / `sk-test`; artifact is path + hash; `spendDisplay` is `unknown`; note says estimated spending limit, not a billing cap
- External `run_command` outcome_unknown: executor not called
- Read retries only when `safeRetry` is true

## Residual / FLAGs

1. **FLAG — lease TTL:** a crashed `running` run is not resumed while its lease is unexpired (default 60s). That is the A12 guard. Recovery waits for expiry. Not a stolen lease.
2. **FLAG — no transcript, no model continue:** resume reconciles and stops unless a checkpoint transcript exists and recovery was safe. Prevents a from-scratch re-prompt from blindly re-applying. Crash before the first checkpoint has no transcript.
3. **FLAG — external uncertainty:** `run_command` (and any external mutation) is not retried. `outcome_unknown` remains. Not exactly-once.
4. **FLAG — not a billing cap:** a request whose reservation fit can still report usage above the limit (fixture: spent about $40 against a $5 estimate). The following request is blocked. In-flight and unknown charges can exceed the estimate.
5. **FLAG — hash, not a journal:** reconciliation trusts a full-file SHA-256 after restart. A torn write that collided with the post-hash is not detected. Mismatch does not overwrite.
6. **FLAG — redactor is pattern-based:** `sk-`, `AKIA`, `Bearer`, `token=` / `api_key=` shapes and secret-like keys. It will miss novel secret formats.
7. **FLAG — limit without prices blocks everything:** if `estimatedSpendingLimitUsd` is set and the price table or `maxOutputTokens` is missing, every new request is refused. Demos do not set a limit.
8. **W08 isolation FLAGs still apply** (bounded subprocess is not a container; no network deny).
9. No leaked reservation found in the fixtures: unknown quotes and dangling holds do not free budget as $0. No blind second write on the post-hash path.

## Confirm
- Scope: **W09 only**
- **Not pushed. Not merged. No PR.**
- No W10+ work.
- Untracked `Harnesses-w07/` was left untracked (prior worktree leftover).
