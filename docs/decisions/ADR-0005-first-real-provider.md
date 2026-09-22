# ADR-0005: First real provider surface (OpenAI-compatible Chat Completions)

Decision ID and date: ADR-0005 / 2026-09-22  
Question: Which real provider API shape should W06 adapt first behind mocks?

## Options considered
1. **OpenAI-compatible Chat Completions streaming** (`POST …/chat/completions`, SSE `data:` chunks, native `tools` / `tool_calls`)
2. Anthropic Messages API (`POST /v1/messages`, `content_block_*` SSE events, Anthropic tool use)
3. Defer real adapter until credentials exist; keep FakeProvider only

## Chosen option or provisional default
**OpenAI-compatible Chat Completions streaming** as the first real adapter surface.

Reasons:
- Same wire shape covers OpenAI and later OpenRouter (and many compatible gateways) with one adapter + different `baseUrl` / headers.
- Native function tools map cleanly to our `tool_request` StreamEvent after argument buffering.
- Streaming + usage (`prompt_tokens` / `completion_tokens`) + HTTP error codes (401/429/…) are well-documented and easy to mock with injectable `fetch`.
- Anthropic remains a strong W10 candidate for a second provider / switch test, not the first surface.

## Evidence
- Master Build Guide § provider interface: `capabilities()`, `stream(request, abortSignal)`, usage/error normalization, buffer tool args until complete validated request.
- W06 acceptance: “Mocked provider conformance passes; live smoke test only if enabled.”
- Kevin supplied **no** credentials/budget for this session → live/network API calls remain disabled.

## Tradeoffs
- Our portable `ProviderMessage` is content-string oriented; full OpenAI assistant `tool_calls` replay fidelity may need enrichment in a later package when switching providers (W10).
- Anthropic-specific features (e.g. prompt caching headers, thinking blocks) are out of scope for this adapter.
- Compatible gateways differ slightly (usage on stream, finish reasons); we normalize what we get and do not invent token counts.

## Contract (single source of truth)
- `packages/contracts/src/provider.ts` — `ModelProvider`, `StreamEvent`, `PROVIDER_ERROR_CODES`, `isModelProvider`
- Every adapter (FakeProvider, OpenAICompatibleProvider, future live) MUST implement that interface and obey StreamEvent rules documented there.
- Vendor wire format stays adapter-private; no cross-track (W07+) coupling.

## Affected contracts and modules
- `packages/providers` — `OpenAICompatibleProvider`, injectable `HttpTransport` / `fetch`
- `@kur3/contracts` `ModelProvider` / `StreamEvent` (unchanged)
- FakeProvider remains the offline demo default

## Revisit trigger
- Owner supplies preferred primary vendor (Anthropic-first) or requires a non-compatible API as default
- Live smoke (`test:live`) enabled with credentials + budget
- W10 second-provider work

## Owner decision required, if any
Confirm OpenAI-compatible-first vs Anthropic-first before treating this as a permanent product default. Live testing still blocked until credentials and budget are supplied (ADR-0004 Q4).
