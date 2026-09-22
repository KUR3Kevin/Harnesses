# Step 2 / W06 change summary (for Kevin)

Date: 2026-09-22 (PT)  
Repo: `/workspace/Harnesses` (GitHub: KUR3Kevin/Harnesses)  
Branch: `step2/w06-provider-adapter` (from main `79a6fef`)  
Feature commit: `299cfc61733ab45e3bbff8d85cf92552b1bcf79f` (+ local doc follow-ups on same branch).
Branch tip: `git rev-parse step2/w06-provider-adapter` (local only; not pushed).
Scope: Master Build Guide work package **W06 only** — first real provider behind mocks  
**Not pushed / not merged** to remote. Track B (W07 / Lim3) is out of scope on this branch.

## What changed

### Contract (SoT — any future live provider must implement)
- `packages/contracts/src/provider.ts` — explicit `ModelProvider` + `StreamEvent` rules + `PROVIDER_ERROR_CODES` + `isModelProvider`
- `packages/contracts/src/provider.test.ts` — schema/code guard tests
- `packages/providers/src/provider-contract.test.ts` — FakeProvider **and** mocked OpenAICompatibleProvider both satisfy the same contract

### Decision
- `docs/decisions/ADR-0005-first-real-provider.md` — **OpenAI-compatible Chat Completions streaming** chosen as the first real surface (also covers OpenRouter later). Anthropic deferred.

### Provider package (`@kur3/providers`)
| File | Role |
| --- | --- |
| `src/http-transport.ts` | Injectable `FetchLike` / `HttpTransport` (tests inject mock fetch) |
| `src/openai-compatible-errors.ts` | Distinct codes: auth, rate_limit, timeout, capability, aborted, network, malformed_tool_args, … + `redactSecrets` |
| `src/openai-compatible-provider.ts` | `OpenAICompatibleProvider` implements `ModelProvider`; SSE → StreamEvent; tool-arg buffering; AbortSignal |
| `src/openai-compatible-provider.test.ts` | Mocked conformance (no network) |
| `src/index.ts` | Exports new adapter **without** removing FakeProvider |

### Docs
- `docs/STATUS.md` — W06 → ready for review
- `docs/handoffs/W06-handoff.md`
- this file

**Unchanged on purpose:** FakeProvider, core runtime, CLI `demo:offline`, contracts schemas, no W07/W08 packages, no live `test:live`, no secrets.

## Why
W06 requires a first real provider adapter with streaming, native tools, error/usage normalization, and **mocked** conformance. Kevin supplied no credentials/budget → all HTTP is injectable; tests never call real endpoints.

## How to run

```bash
cd /workspace/Harnesses
npm install          # if needed
npm run build
npm run typecheck
npm test
npm run demo:offline
```

Optional (not enabled this session): wire `OpenAICompatibleProvider` with a real `baseUrl` + apiKey only when Kevin supplies credentials and a small stated budget. Do **not** enable live tests without that.

## Commands that passed (this session)

| Command | Result |
| --- | --- |
| `npm run build` | **pass** (`tsc -b`) |
| `npm run typecheck` | **pass** |
| `npm test` | **pass** — includes 11 new OpenAI-compatible mocked conformance tests + existing FakeProvider/core/policy/… + integration |
| `npm run demo:offline` | **pass** — `DEMO OK (offline)`; FakeProvider still edits fixture |

Environment: Linux x86_64, Node v20.19.2, npm 9.2.0.

## Unverified / not run
- Live OpenAI / OpenRouter / Anthropic API calls
- `npm run test:live` (not configured / no credentials)
- Production credential storage / editor secret UI (W07+)
- Second provider switching (W10)
- Full A01–A20 acceptance suite claim (A20 partially evidenced via mocked 401/429/abort only)

## Residual / flag for Crokpot (not blockers)
- Portable `ProviderMessage` is still content-string oriented (no assistant `tool_calls[]` field). Live multi-turn tool replay against strict OpenAI servers may need a **small additive** contract field later — not required for mocked W06. **Not** cross-track coupling; do not fold into W07.
- `StreamEvent.error.code` remains `string` at runtime schema with **canonical** `PROVIDER_ERROR_CODES` preferred — avoids closed-enum thrash; adapters should use the canonical set.

## Risks / known limitations
- Portable `ProviderMessage` is content-string oriented; full OpenAI assistant `tool_calls` history replay may need enrichment before multi-turn live use / W10 switch.
- Compatible gateways vary on streamed usage; we emit usage only when present (no invented zeros).
- Adapter is ready for review, not “verified complete” until Kevin accepts evidence.

## What’s next
1. Kevin reviews ADR-0005 + this summary + mocked test evidence.
2. Track B / **W07** on a **separate** branch (parent / Lim3 ownership as directed) — not this branch.
3. Later: optional live smoke only if credentials + budget supplied; W10 second provider.

## Confirm
- Scope: **W06 / Track A only** inside `/workspace/Harnesses`
- **Not pushed. Not merged. No PR opened.**
