# Step 4 — W10 change summary (second provider + switching)

Branch: `step4/w10-second-provider` from main `a55ffd8` (W09 = PR #6). Local only, not pushed.

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

## Residuals / FLAGs
- switch is a pure core API; not wired into HarnessRuntime or a `switch_provider` bridge command.
- Tool results become user text for the Anthropic-style adapter (lossy, explicit).
- No live API; vendor wire drift unproven.
- Redaction is best-effort (same W09 caveat).
