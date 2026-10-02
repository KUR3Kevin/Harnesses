# ADR-0004: Provisional defaults vs open owner questions

Decision ID and date: ADR-0004 / 2026-09-21  
Question: Which product choices remain owner decisions, and what defaults allow offline progress?

## Provisional defaults (builder-chosen, not owner-confirmed)
| Topic | Provisional default |
| --- | --- |
| First shipping format | VS Code extension prototype (CLI offline demo first) |
| First provider | Deterministic `FakeProvider` only |
| Isolation stage | W08 bounded subprocess on Linux/macOS (ADR-0007); not a full container sandbox |
| License / distribution | Not selected; no LICENSE file yet |
| Runtime foundation | Custom loop (ADR-0002) |
| Storage | JSON file store (ADR-0003) |
| Package manager | npm workspaces |

## Open questions that materially affect later work (guide §19)
1. First release: VS Code extension vs branded Code OSS?
2. Exact OS / CPU matrix beyond this Linux x86_64 builder?
3. One real coding task the first prototype must complete (beyond the hello fixture)?
4. Provider credentials and live testing budget (blocked until supplied)?
5. Which actions auto-run vs require scoped approval?
6. Audience: KUR3 alone, small group, or public?
7. Primary frustration vs existing tools?

## Evidence
Master Build Guide §1 table and §19; environment inspection on 2026-09-21.

## Tradeoffs
Proceeding with defaults unblocks W01–W05. Silently treating defaults as confirmed owner requirements would be incorrect.

## Affected contracts and modules
Docs, roadmap status, W06+ provider and W07/W12 packaging.

## Revisit trigger
Any owner answer to the questions above.

## Owner decision required, if any
Yes — all seven open questions before claiming a release candidate.
