Task ID: W07 (Step 2 Track B — editor integration)
Builder/model as reported by the interface: Grok Bot (executor subagent)
Date: 2026-09-22 (America/Los_Angeles)
Base commit or supplied source snapshot: main `79a6fef`
Resulting commit or patch reference: _(filled after local commit)_ on branch `step2/w07-editor-integration` (local only; not pushed)

Objective:
Deliver Master Build Guide W07 only: VS Code panel/commands, versioned bridge to `@kur3/core`, FakeProvider offline demo, docs/ADR/STATUS — composing on main without W06.

Files changed:
- packages/contracts (bridge protocol)
- packages/core (InProcessHarnessBridge + runtime cancel/currentRunId)
- packages/providers (FakeProvider preDelayMs)
- apps/vscode-extension (real extension wiring)
- docs/decisions/ADR-0006, docs/STATUS.md, docs/STEP2-W07-CHANGE-SUMMARY.md, this handoff
- README.md, root package.json / tsconfig.json

Interfaces changed:
- New bridge request/response contracts (`BRIDGE_PROTOCOL_VERSION`)
- `InProcessHarnessBridge.handle`
- Extension commands `kur3.openPanel` / `kur3.startOfflineDemo` / `kur3.cancelRun`
- `npm run demo:extension-offline`

Decisions and reasons:
- See ADR-0006 (stdio IPC + in-process bridge core; no W06 coupling)

Checks actually executed:
- See docs/STEP2-W07-CHANGE-SUMMARY.md (filled after verify)

Checks not executed and why:
- `npm run package:extension` / Marketplace publish — FLAG, not in W07 cut
- Live provider / W06 adapter — out of scope
- Interactive VS Code UI F5 session — not available in this builder; IPC + offline demo cover the bridge path

Acceptance IDs (partial / local evidence only):
- A01/A02-ish via offline demos
- A16-ish reconnect: subscribe_events does not start a run; duplicate event window stable in tests
Not claimed: full A01–A20

Known limitations:
- See FLAGs in STEP2-W07-CHANGE-SUMMARY.md

Uncommitted or conflicting work:
- None after local commit on this branch

Remaining tasks:
- Kevin review; optional F5 manual smoke in VS Code
- Do not merge until W06/W07 review strategy is clear; keep branches separate

Exact next action:
Kevin reviews `docs/STEP2-W07-CHANGE-SUMMARY.md` and ADR-0006.

Files the next model needs:
- docs/STEP2-W07-CHANGE-SUMMARY.md, docs/decisions/ADR-0006-editor-bridge.md
- apps/vscode-extension/src/*, packages/core/src/bridge.ts, packages/contracts/src/bridge.ts
