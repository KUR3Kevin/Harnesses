# Step 4 — W10 change summary (second provider + switching)

Branch: `step4/w10-second-provider` from main `a55ffd8` (W09 = PR #6). PR #7.

## Landed
- `packages/providers/src/anthropic-messages-provider.ts` — second adapter, Anthropic-Messages-style wire format, injectable fetch, mocks only. + `toAnthropicMessages` converter.
- `packages/providers/src/provider-contract.test.ts` — shared conformance suite run against all three adapters.
- `packages/providers/src/anthropic-messages-provider.test.ts` — wire format, buffered tool args, opaque thinking dropped, usage not invented, error/abort mapping, key redaction.
- `packages/contracts/src/portable-checkpoint.ts` — `PortableCheckpointSchema` (additive).
- `packages/core/src/provider-switch.ts` — `toPortableCheckpoint`, `handoffPreamble`, `switchProvider`.
- `packages/core/src/provider-switch.test.ts` — A15 switch (sent through the mocked new adapter), round trip back, opaque-state-not-forwarded, refuse-with-pending-call (checkpoint + outcome_unknown ledger), refuse no-checkpoint/running/same, budget reservation guard, redaction.
- ADR-0009, W10 handoff, STATUS update.

## Exit check / A15
- Two (three) providers meet the same contract: shared suite green.
- Clean-boundary switch preserves goal, scope, decisions+reasons, artifact refs (path+hash), check evidence, repo revision, next action.

## Verification (2026-10-10 PT, Node v20.19.2)
- npm run build — success
- npm run typecheck — success
- npm test — success, 0 failures (providers 30, core 32, others unchanged)
- npm run demo:offline — DEMO OK (offline)
- npm run demo:extension-offline — DEMO EXTENSION-OFFLINE OK

## PR #7 review fixes (2026-10-23 PT)

Scope approved by the owner: the P0 and all six P1s from the ChatGPT review, plus tests. Switch design (owner's choice): a small verified conversation handoff, not full conversation inheritance.

| Finding | Fix |
|---|---|
| **P0** `switchProvider()` did not change the provider the runtime/bridge stream through | `HarnessRuntime` keeps a provider registry (`provider` + `providers[]`) and resolves every turn from the run's persisted `providerId`; `runtime.switchProvider()` persists the switch; the bridge forwards `providers` and has a new `switch_provider` command. After pause → switch → resume, the next turn streams through the new provider (tested through the bridge and through a fresh runtime). |
| **P1-1** weak guard | Refuses unless `checkpoint.lastEventSequence === run.lastEventSequence` (`stale_checkpoint`), `checkpoint.runState === run.state`, `taskFacts.taskId === run.taskId`, the state is `paused`/`budget_exhausted`, and the tool-call ledger is supplied (`toolCalls` is now required; `undefined` → `ledger_unavailable`) and agrees with `tool_started`/`tool_finished` events (`ledger_mismatch`) with nothing pending. Runtime checkpoints now cover their own `checkpoint_saved` event (one atomic write) and are re-sealed after trailing verification events, so a real paused run passes the strict guard. |
| **P1-2** Anthropic tool emission / malformed args | Tool blocks are validated after `message_stop`; one malformed block invalidates the whole turn: one `malformed_tool_args` error, zero `tool_request`, no `completed`. Order documented: text streams live; at `message_stop` → `usage` (if reported) → `tool_request`s in block-index order → `completed`. Same semantics applied to the OpenAI-compatible adapter and written into the contract. |
| **P1-3** tool results as plain user text | `ProviderMessage` gains assistant `toolCalls`. Runtime records structured tool calls. Anthropic sends `tool_use` + paired `tool_result` (`tool_use_id`); OpenAI sends `tool_calls` + `tool_call_id`. An orphan tool message is a JSON envelope (`kur3.untrusted_tool_output`), never bare user text. |
| **P1-4** non-atomic, unleased, non-idempotent switch | `RunStore.commitProviderSwitch` writes run + checkpoint + `provider_switched` event + request-id record in one temp→fsync→rename snapshot; memory changes only after the write succeeds; sequence re-checked on disk (`stale_run`). `runtime.switchProvider` holds a per-request run lease (a racing switch or a live drive gets `lease_held`). A repeated request id is a no-op (`idempotent: true`); a reused id for another target is `request_id_conflict`. |
| **P1-5** error could end `completed` | Any provider `error` (or contract-violating tool request) in a turn ends the run `failed` with `run_state_changed {state: failed, reason}`; no tool from that turn runs, even if the adapter also sent `completed`. |
| **P1-6** no vendor verification | Recorded-shape fixtures (`packages/providers/src/fixtures/vendor-streams.ts`) mirror the documented Anthropic Messages and OpenAI Chat Completions streaming events, with contract tests in `vendor-contract.test.ts`. `live-vendor.test.ts` is an opt-in live test, skipped unless `KUR3_LIVE_VENDOR_TESTS=1` plus `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are set. **Still open: no real-key run has been done.** |
| Handoff | `toPortableCheckpoint` now emits a 2-message handoff (system preamble with verified checkpoint sequence/state/task, goal, scope, acceptance, decisions, artifacts, checks, remaining work, next action + one continuation turn). The old transcript is dropped (`transcript:not_inherited(N)`). `verifyPortableCheckpoint` checks required facts (`taskId`, `goal`, `mode`), no secret-shaped strings, and a sha256 `handoffDigest`; failure → `handoff_invalid`. |
| P2 (cheap) | Anthropic SSE frame cap (`maxFrameBytes`, default 1 MiB → `malformed_sse`). 401/429 mapping covered for both vendors. |

New tests: `packages/core/src/provider-switch-runtime.test.ts` (13), new cases in `provider-switch.test.ts` (+5), `anthropic-messages-provider.test.ts` (+7), `vendor-contract.test.ts` (8), `live-vendor.test.ts` (2, skipped by default), `run-store.test.ts` (+1).

### Verification (2026-10-23 PT, Node v20.19.2, after deleting every `*.tsbuildinfo` and `packages/*/dist`, `apps/*/dist`)
- npm run build — success
- npm run typecheck — success
- npm test — 149 tests: 147 pass, 0 fail, 2 skipped (opt-in live vendor). contracts 10/10, core 50/50, policy 11/11, providers 45 pass + 2 skipped of 47, storage 6/6, tools 4/4, worker 17/17, vscode-extension 1/1, integration 3/3.
- npm run demo:offline — DEMO OK (offline)
- npm run demo:extension-offline — DEMO EXTENSION-OFFLINE OK

## Residuals / FLAGs (after review fixes)
- **Open:** real-key run of `live-vendor.test.ts` against Anthropic and OpenAI (needs keys; never run here).
- Lease is TTL-based (60 s). A process that dies mid-switch blocks other switches on that run until the lease expires; the atomic write means state is never half-applied.
- The runtime still executes only the first tool request of a multi-tool turn (pre-existing); the structured transcript records only that call so pairing stays valid.
- Single-file JSON store: optimistic sequence check + lease protect switches, but general multi-process writers remain a W03-era limitation (ADR-0003).
- Redaction is best-effort (same W09 caveat); the handoff validator rejects anything the redactor still recognises.
- Other P2 items from the review not done here.

## Residuals / FLAGs (original W10 pass, superseded where noted)
- ~~switch is a pure core API; not wired into HarnessRuntime or a `switch_provider` bridge command.~~ Fixed (P0).
- ~~Tool results become user text for the Anthropic-style adapter (lossy, explicit).~~ Fixed (P1-3).
- No live API; vendor wire drift unproven — fixtures added (P1-6), real-key run still open.
- Redaction is best-effort (same W09 caveat).
