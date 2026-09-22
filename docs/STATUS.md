# KUR3 Harness — status

Updated: 2026-09-21 (PT)  
Base revision: local Step 1 scaffold (see git log after commit)  
Guide: `KUR3-Harness-Master-Build-Guide.md` v0.2

| Task | Status | Owner/session | Base revision | Evidence | Next action |
| --- | --- | --- | --- | --- | --- |
| W00 | ready for review | Grok Bot Step 1 | docs/master-build-guide + local scaffold | ADRs 0001–0004; env Node 20.19.2 / npm 9.2.0 / Linux x86_64 | Kevin reviews ADRs / open questions |
| W01 | ready for review | Grok Bot Step 1 | same | packages + schemas; `npm run typecheck` / build | Kevin reviews contracts |
| W02 | ready for review | Grok Bot Step 1 | same | Custom runtime provisional; Pi/Deep Agents **not** compared (ADR-0002) | Optional foundation spike |
| W03 | ready for review | Grok Bot Step 1 | same | `RunStore` events + lease tests | Consider SQLite migration |
| W04 | ready for review | Grok Bot Step 1 | same | path guard + patch conflict tests | Keep `run_command` disabled |
| W05 | ready for review | Grok Bot Step 1 | same | offline loop + `demo:offline` | Start W06 only after Kevin review |
| W06 | not started | Unassigned | — | None | First real provider behind mocks |
| W07 | not started | Unassigned | — | vscode-extension stub only | Editor panel + bridge |
| W08 | not started | Unassigned | — | None | Isolated command worker |
| W09 | not started | Unassigned | — | None | Recovery + budget hardening |
| W10 | not started | Unassigned | — | None | Second provider + switching |
| W11 | not started | Unassigned | — | None | Evals + release candidate |
| W12 | not started | Unassigned | — | None | Optional Code OSS (owner select) |

Allowed statuses: not started, in progress, blocked, ready for review, verified complete.

**Note:** "ready for review" means code and local check output are available. **verified complete** requires Kevin’s acceptance of recorded evidence. Do not treat this table as claiming A01–A20 all pass.
