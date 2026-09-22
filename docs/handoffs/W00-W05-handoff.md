Task ID: W00–W05 (Step 1 scaffold)
Builder/model as reported by the interface: Grok Bot (executor subagent)
Date: 2026-09-21 (America/Los_Angeles)
Base commit or supplied source snapshot: f569404 (docs/master-build-guide + README only)
Resulting commit or patch reference: 973aaa52d49fc956078af47bc44e000bcee1a550 on branch step1/w00-w05-offline-scaffold (local only; not pushed)

Objective:
Deliver offline monorepo scaffold through W00–W05 with fake provider, durable store, policy/file tools, integrated loop, demo:offline, ADRs, STATUS, and truthful check evidence.

Files changed:
- Root: package.json, package-lock.json, tsconfig*.json, .gitignore, README.md
- packages/contracts, core, providers, policy, tools, worker, storage
- apps/cli, apps/vscode-extension (stub)
- fixtures/demo-project
- tests/integration
- docs/decisions/ADR-0001..0004, docs/STATUS.md, docs/STEP1-CHANGE-SUMMARY.md, this handoff

Interfaces changed:
- New @kur3/* package boundaries and Zod contracts (protocol 0.1.0)
- ModelProvider, RunStore, HarnessRuntime, FileWorker, tool registry

Decisions and reasons:
- See docs/decisions/ADR-0001 (npm + Node 20), ADR-0002 (custom runtime provisional), ADR-0003 (JSON store provisional), ADR-0004 (open questions)

Checks actually executed:
- Command: npm install
  Environment: Linux x86_64, Node v20.19.2, npm 9.2.0
  Result: success (lockfile created; 0 vulnerabilities reported)
- Command: npm run build
  Result: success (tsc -b)
- Command: npm run typecheck
  Result: success
- Command: npm test
  Result: package unit tests + integration tests passed (see STEP1-CHANGE-SUMMARY for counts)
- Command: npm run demo:offline
  Result: DEMO OK (offline); fixture edited to hello, kur3; verification passed

Checks not executed and why:
- npm run lint — no linter configured yet
- npm run test:live — no credentials / paid APIs (intentionally)
- Pi vs Deep Agents hands-on comparison — deferred (ADR-0002)
- VS Code extension packaging / editor demo — stub only (W07)
- SQLite backend — provisional JSON store (ADR-0003)
- Network-disabled OS firewall proof — demo uses FakeProvider with no network calls; full offline NIC disable not run

Acceptance IDs satisfied (partial / local evidence only):
- A01 (offline startup via demo:offline) — local evidence
- A02 (basic task fixture change) — local evidence
- A03 (plan mode cannot apply write) — unit test evidence
- A04 (path traversal blocked) — unit test evidence
- A05 (stale hash conflict) — unit test evidence
- A12 (duplicate lease rejected) — unit + integration evidence
Not claimed: A06–A11, A13–A20

Known limitations:
- File worker is path-checked, not a sandbox
- run_command disabled until W08
- No real provider
- vscode-extension is a stub
- Storage is JSON, not SQLite
- Custom runtime not compared to Pi/Deep Agents

Uncommitted or conflicting work:
- None after local commit 973aaa5 (working tree clean at handoff update)

Remaining tasks:
- W06+ after Kevin review; address open questions in ADR-0004

Exact next action:
Kevin reviews docs/STEP1-CHANGE-SUMMARY.md and ADRs; then assign W06 (first real provider behind mocks) or request foundation spike (Pi/Deep Agents).

Files the next model needs:
- KUR3-Harness-Master-Build-Guide.md
- docs/STATUS.md, docs/decisions/*, docs/handoffs/W00-W05-handoff.md, docs/STEP1-CHANGE-SUMMARY.md
- packages/*/src, apps/cli/src, fixtures/demo-project
