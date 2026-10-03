# ADR-0008: Recovery reconciliation and estimated spending limit (W09)

Decision ID and date: ADR-0008 / 2026-10-02  
Question: How should an interrupted tool call and a model request be retried without a blind duplicate write, and without treating unknown cost as zero?

## Options considered
1. **Replay the event log blindly** on resume (re-execute every non-terminal call).
2. **Hash reconciliation for file writes; no automatic retry of external mutations; reserve cost before the provider call.**
3. **A provider-side billing cap** (not available; would over-claim).

## Chosen option
**Option 2.**

### Tool calls
Lifecycle stays `prepared → running →` a recorded terminal outcome (`succeeded`, `failed`, `denied`). A crash between `running` and that record becomes `outcome_unknown`.

Before any retry:
- `apply_patch` is reconciled with expected pre/post content hashes (`inspectHash`, no write).
  - Post-hash already on disk → record success, **do not write**.
  - Pre-hash still current → **one** `applyPatch` (the worker still refuses a stale hash).
  - Neither hash → **conflict, no overwrite**.
  - Missing hashes → do not retry.
- Read-only tools retry only when `safeRetry` is true (`read_file`, `search_files`, `propose_patch`).
- `run_command` and any other external mutation are **never** auto-retried. Outcome stays `outcome_unknown`. This does **not** promise exactly-once external execution.

`resume_run` acquires the run lease (re-read from disk so another process's lease is visible), reconciles pending calls, then continues the model loop only when a checkpoint transcript exists and reconciliation did not end in conflict or `unsafe_no_retry`. Otherwise the run stays paused (or `budget_exhausted`) and the handoff states the remaining work. A second resume does not apply the same write again.

A run left in `running` with an expired or absent lease is marked `run_interrupted` and moved to `paused` after reconciliation. An unexpired lease held by another holder is not stolen (A12). Default lease TTL remains 60s, so a crashed holder is not resumed until the lease expires.

A dangling `reservedUsd` (crash after reserve, before usage) is moved to `unknownHeldUsd`. It is not refunded as $0.

### Budget
This is an **estimated spending limit**, not a guaranteed provider billing cap. The constant `ESTIMATED_SPENDING_LIMIT_NOTE` is stored on reservations, reconciliations, and handoffs.

- No limit configured → requests are not blocked (offline demos).
- Limit configured → quote estimated input tokens (chars/4) plus `maxOutputTokens` at the configured USD / 1k rates. The hold is persisted **before** `provider.stream`.
- Unknown price, unknown max output, or non-finite quote → label `unknown` and **refuse** the request. Unknown is never coerced to 0.
- Remaining = limit − spentKnown − reserved − unknownHeld. If the quote does not fit, state becomes `budget_exhausted` and no new billable request starts.
- After the response, reconcile to reported tokens when both price and usage are present. Otherwise the reservation stays in `unknownHeldUsd` and the display is `unknown` (the field `estimatedCostUsd` is omitted, not set to 0).
- Reported usage can exceed the reservation. That overage is recorded. The next request is blocked. In-flight work can exceed the estimate.
- Leaving `budget_exhausted` requires `raiseEstimatedSpendingLimit` (explicit update, event `budget_limit_raised`) and then `resume_run`. The raise itself does not send a request.

### Export
`export_handoff` emits portable facts: goal, scope, decisions, verification outcomes, artifact references (path + hash, not file bodies), remaining work, blockers, risks, and the next action. Strings are passed through a redactor (`sk-`, `AKIA`, `Bearer`, `token=` / `api_key=` shapes, and secret-like object keys). Pattern redaction is not a complete secret scanner.

## Tradeoffs
- Safer than replay. We can still be wrong if a torn write hashes to the expected post-image (not journaled).
- External side effects stay uncertain rather than duplicated.
- A spending limit without a price table blocks every new request. That is intentional.
- Transcript continuation is best-effort. No transcript → reconcile and stop, do not re-prompt from scratch (that could re-issue a write).

## Affected modules
`packages/contracts` (budget snapshot, handoff, tool-call hashes, events, `resume_run` / `export_handoff`), `packages/storage` (tool calls, lease reload), `packages/worker` (`inspectHash`), `packages/core` (runtime, recovery, budget, handoff, bridge).

W06 `ModelProvider`, W07 bridge commands, and W08 `CommandWorker` / `run_command` behavior are unchanged aside from additive bridge commands and usage-event labels when the runtime records cost.

## Revisit trigger
- Need a write-ahead journal instead of full-file hashes.
- Provider idempotency keys for external tools.
- A real price catalog and a tested live budget (still not a billing cap).

## Owner decision required
Confirm the 60s lease TTL is an acceptable crash-recovery delay versus stealing a live lease. W09 does not steal an unexpired lease.
