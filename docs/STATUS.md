# KUR3 Harness — status

Updated: 2026-10-10 (PT)  
Base revision: branch `step4/w10-second-provider` from main `a55ffd8` (includes merged W09 PR #6)  
Guide: `KUR3-Harness-Master-Build-Guide.md` v0.2

| Task | Status | Owner/session | Base revision | Evidence | Next action |
| --- | --- | --- | --- | --- | --- |
| W00 | ready for review | Grok Bot Step 1 | docs/master-build-guide + local scaffold | ADRs 0001–0004; env Node 20.19.2 / npm 9.2.0 / Linux x86_64 | Kevin reviews ADRs / open questions |
| W01 | ready for review | Grok Bot Step 1 | same | packages + schemas; `npm run typecheck` / build | Kevin reviews contracts |
| W02 | ready for review | Grok Bot Step 1 | same | Custom runtime provisional; Pi/Deep Agents **not** compared (ADR-0002) | Optional foundation spike |
| W03 | ready for review | Grok Bot Step 1 | same | `RunStore` events + lease tests | Consider SQLite migration |
| W04 | ready for review | Grok Bot Step 1 | same | path guard + patch conflict tests | — |
| W05 | ready for review | Grok Bot Step 1 | same | offline loop + `demo:offline` | — |
| W06 | ready for review | Grok Bot Step 2 Track A | main (merged) | ADR-0005; contracts ModelProvider SoT; OpenAI-compatible mocked adapter + conformance; FakeProvider green | Kevin reviews W06 summary / handoff |
| W07 | ready for review | Grok Bot Step 2 Track B | main (merged) | Panel + stdio bridge + FakeProvider offline; ADR-0006; `demo:extension-offline` | Kevin reviews STEP2-W07 summary |
| W08 | ready for review | Grok Bot Step 3 | step3/w08-isolated-worker | ADR-0007 bounded subprocess; CommandWorker + run_command; containment/cancel/timeout/env tests | Kevin reviews STEP3-W08 summary / isolation FLAGs |
| W09 | ready for review | Grok Bot Step 3 | step3/w09-recovery-budget | ADR-0008; hash reconciliation; reservations; redacted export; crash/retry fixtures | Kevin reviews STEP3-W09 summary |
| W10 | ready for review | Grok Bot Step 4 | step4/w10-second-provider | ADR-0009; AnthropicMessages mocked adapter; shared 3-adapter conformance; portable checkpoint + switchProvider; A15/pending/opaque fixtures | Kevin reviews STEP4-W10 summary |
| W11 | not started | Unassigned | — | None | Evals + release candidate |
| W12 | not started | Unassigned | — | None | Optional Code OSS (owner select) |

Allowed statuses: not started, in progress, blocked, ready for review, verified complete.

**Note:** "ready for review" means code and local check output are available. **verified complete** requires Kevin’s acceptance of recorded evidence. Do not treat this table as claiming A01–A20 all pass.
