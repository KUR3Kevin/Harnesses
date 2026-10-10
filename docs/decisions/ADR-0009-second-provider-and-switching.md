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
