Task ID: W06 (first real provider adapter — mocked)
Builder/model as reported by the interface: Grok Bot (executor subagent)
Date: 2026-09-22 (America/Los_Angeles)
Base commit or supplied source snapshot: 79a6fef32704036ca73a955e2b8ed5b50937a0e8 (main tip)
Resulting commit or patch reference: 299cfc61733ab45e3bbff8d85cf92552b1bcf79f on branch step2/w06-provider-adapter (local only; not pushed)

Objective:
Deliver first real provider surface (OpenAI-compatible Chat Completions streaming) behind injectable mock transport; conformance tests; ADR-0005; STATUS/handoff/summary. No live/paid API calls. Keep FakeProvider + demo:offline green. Track A / W06 only.

Files changed:
- packages/contracts/src/provider.ts (explicit ModelProvider contract / PROVIDER_ERROR_CODES)
- packages/contracts/src/provider.test.ts
- packages/providers/src/provider-contract.test.ts
- packages/providers/src/http-transport.ts
- packages/providers/src/openai-compatible-errors.ts
- packages/providers/src/openai-compatible-provider.ts
- packages/providers/src/openai-compatible-provider.test.ts
- packages/providers/src/index.ts
- docs/decisions/ADR-0005-first-real-provider.md
- docs/STATUS.md
- docs/handoffs/W06-handoff.md
- docs/STEP2-W06-CHANGE-SUMMARY.md

Interfaces changed:
- New `OpenAICompatibleProvider` implementing `ModelProvider`
- Injectable `FetchLike` / `HttpTransport` (tests never use real network)
- Error code normalization: auth, rate_limit, timeout, capability, aborted, malformed_tool_args, …

Decisions and reasons:
- See docs/decisions/ADR-0005 (OpenAI-compatible first; Anthropic deferred to W10+)

Checks actually executed:
- Recorded in docs/STEP2-W06-CHANGE-SUMMARY.md after this session’s npm run build / typecheck / test / demo:offline

Checks not executed and why:
- npm run test:live — no credentials / budget; intentionally disabled
- Real OpenAI/OpenRouter/Anthropic network calls — forbidden for this assignment
- W07+ editor / worker / second provider — out of scope (separate branches)

Acceptance IDs touched (local evidence only):
- A20 (provider failure distinct codes) — unit evidence via mocked 401/429/abort
- Streaming / tool assembly / usage — mocked conformance (not full A-suite claim)

Known limitations:
- Portable ProviderMessage lacks full assistant tool_calls replay; may need enrichment at W10
- Live smoke not run
- FakeProvider remains demo default

Uncommitted or conflicting work:
- None intended after local W06 commit (working tree clean at handoff)

Remaining tasks:
- Kevin review of W06; then W07 on a **separate** branch (Track B)

Exact next action:
Kevin reviews docs/STEP2-W06-CHANGE-SUMMARY.md and ADR-0005; accept or request changes. Do not merge until review. Parent opens Track B (W07) separately.

Files the next model needs:
- KUR3-Harness-Master-Build-Guide.md
- docs/STATUS.md, docs/decisions/ADR-0005-*, docs/handoffs/W06-handoff.md, docs/STEP2-W06-CHANGE-SUMMARY.md
- packages/providers/src/*, packages/contracts/src/provider.ts
