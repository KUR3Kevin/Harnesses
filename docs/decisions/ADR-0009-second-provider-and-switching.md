# ADR-0009: Second provider adapter and clean-boundary switching (W10)

Decision ID and date: ADR-0009 / 2026-10-10
Question: Which second adapter proves the W06 contract is provider-neutral, and how does a run move between providers without losing task facts or leaking opaque state?

## Options considered
1. Second OpenAI-compatible endpoint (same wire format) — proves little.
2. **Anthropic-Messages-style adapter** (different auth headers, top-level `system`, named SSE events, `input_json_delta` tool args, split usage) behind injectable fetch.
3. Forward the previous provider's native transcript/state on switch.
4. **Portable checkpoint**: allow-listed task facts + portable `ProviderMessage` fields + W09 handoff, rendered as a leading system preamble.

## Chosen
Options 2 and 4.

- `AnthropicMessagesProvider` implements the unchanged `ModelProvider`. Thinking / redacted_thinking / signature blocks are dropped inside the adapter and never become `StreamEvent`s. Tool args are buffered and emitted only as complete JSON objects. Usage is emitted only when reported. A stream without `message_stop` is `malformed_sse`.
- Portable `tool` messages are rendered as user text for this adapter, because the portable transcript carries no matching assistant `tool_use` block and the Messages API rejects an orphan `tool_result`. Lossy but explicit.
- One shared conformance suite runs against FakeProvider, OpenAICompatible (mocked), and AnthropicMessages (mocked).
- `switchProvider` (core, pure) refuses on: no checkpoint, checkpoint/run mismatch, run `running`, any pending or `outcome_unknown` call (checkpoint or ledger), `reservedUsd > 0`, same provider+model. On success it returns the new Run/Checkpoint for the caller to persist; known spend and unknown holds stay on the run, `reservedUsd` is 0.
- `toPortableCheckpoint` keeps only `PORTABLE_TASK_FACT_KEYS`; non-portable keys and message fields are dropped and listed by name (not value) in `dropped`; secret-shaped strings are redacted (W09 redactor, best-effort).

## Consequences
- `ModelProvider` contract unchanged. Additive: `PortableCheckpointSchema` in contracts, `provider-switch.ts` in core, new adapter export in providers.
- Not wired into `HarnessRuntime` or the bridge (`switch_provider` bridge command not added) — callers persist the result. Deferred to keep W06–W09 surfaces untouched.
- No live API was called; real-vendor wire drift is not proven.

## Amendment 2026-10-23 — PR #7 review fixes

Supersedes the "not wired" and "tool results as user text" points above.

- **Switch is live (P0).** `HarnessRuntime` resolves each turn's provider from the run's persisted `providerId` via a registry (`provider` + `providers[]`). `HarnessRuntime.switchProvider(runId, {requestId, toProviderId, toModelId})` and bridge command `switch_provider` persist the switch; the next `resume_run` streams through the new provider.
- **Strict clean boundary (P1-1).** Additional refusals: `stale_checkpoint` (sequence ≠ run), `checkpoint_state_mismatch`, `task_mismatch`, `run_not_switchable`, `ledger_unavailable` (ledger is required), `ledger_mismatch` (ledger vs `tool_started`/`tool_finished` events, or foreign-run entries), `handoff_invalid`. Runtime checkpoints are written together with their own `checkpoint_saved` event so a freshly paused run satisfies the strict check.
- **Handoff = small verified conversation handoff (owner decision).** Not full conversation inheritance. The new provider receives a system preamble (verified checkpoint sequence, state, task, goal, scope, acceptance, decisions, artifacts, checks, remaining work, next action) plus one continuation turn. Validated for required facts, secret-shaped strings and a sha256 digest. Reason: smaller attack and leak surface, no dependency on provider-specific transcript shapes, and verifiable content; cost is that the new provider must re-read files.
- **Atomic, leased, idempotent (P1-4).** One temp→fsync→rename snapshot holds run, checkpoint, `provider_switched` event and the request-id record; per-request run lease; repeated request id = no-op.
- **Errors fail the run (P1-5)** and invalidate the turn: no tool from an errored turn executes.
- **Turn-level tool validation (P1-2)** in both live-style adapters: one malformed call → whole turn invalid.
- **Structured tool results (P1-3).** `ProviderMessage.toolCalls` on assistant turns; adapters emit native tool_use/tool_result (Anthropic) or tool_calls/tool_call_id (OpenAI). Orphans become a JSON "untrusted tool output" envelope.
- **Vendor verification (P1-6).** Documented-shape fixtures + contract tests; opt-in live test (`KUR3_LIVE_VENDOR_TESTS=1`). A real-key run is still open.
- Contract additions (additive): `ProviderToolCallSchema`, `ProviderMessage.toolCalls`, `provider_switched` event type, `switch_provider` bridge command, `switch_refused` bridge error, `PortableCheckpoint.verifiedAgainst` + `handoffDigest`. `switchProvider()`'s `toolCalls` argument is now required (breaking for direct callers of the pure function; none outside tests).
