Task ID: W10 (Step 4 — second provider and switching)
Builder/model as reported by the interface: Grok Bot (executor subagent)
Date: 2026-10-10 (America/Los_Angeles)
Base commit: main `a55ffd8`
Resulting commit: feature `6580944c427e04617bb467420d461f9eb0ecc213` on `step4/w10-second-provider` (docs commit follows; not pushed)

Objective:
Master Build Guide W10 only: second adapter, portable checkpoint conversion, clean-boundary provider switch (A15).

Files changed:
- packages/providers (anthropic-messages-provider + tests, shared conformance suite, index export)
- packages/contracts (portable-checkpoint.ts, index export)
- packages/core (provider-switch.ts + tests, index export)
- docs/decisions/ADR-0009-second-provider-and-switching.md, docs/STEP4-W10-CHANGE-SUMMARY.md, docs/STATUS.md, this handoff

Interfaces changed (additive only):
- `AnthropicMessagesProvider`, `toAnthropicMessages`
- `PortableCheckpointSchema`
- `toPortableCheckpoint`, `switchProvider`, `handoffPreamble`, `PORTABLE_TASK_FACT_KEYS`
- `ModelProvider`, bridge protocol, runtime unchanged

Decisions and reasons: see ADR-0009.

Checks actually executed: build, typecheck, test, demo:offline, demo:extension-offline — all success.
Environment: Linux x86_64, Node v20.19.2.

Checks not executed and why:
- Live provider calls — forbidden.
- Runtime/bridge integration of switch — not in scope for this pass (residual).

Remaining work / next action:
- Kevin reviews; PR opens the PR. Optional follow-up: wire `switch_provider` into runtime + bridge.

## Review-fix pass (2026-10-23 PT)
Scope: PR #7 review P0 + P1-1..P1-6 + tests (owner-approved). See STEP4-W10-CHANGE-SUMMARY.md "PR #7 review fixes" and the ADR-0009 amendment.
Checks executed after a clean build (tsbuildinfo + dist removed): build, typecheck, test (149: 147 pass, 0 fail, 2 opt-in live skipped), demo:offline, demo:extension-offline — all success.
Not executed: live vendor test (needs real keys; forbidden here).
Next action: Kevin reviews; merge only on Kevin's explicit yes.
