# Step 2 / W07 change summary (for Kevin)

Date: 2026-09-22 (PT)  
Repo worktree: `/workspace/Harnesses/Harnesses-w07` (GitHub: KUR3Kevin/Harnesses)  
Branch: `step2/w07-editor-integration` (from main `79a6fef`)  
Feature commit: `6e0553848e4896e819ec975674dc2314aa33c68b`
Branch tip: `322fdb8c1f729474dbe936b25e57e8fcaae75ce7` (local only; not pushed)
Scope: Master Build Guide work package **W07 only** — editor integration (panel + bridge)  
**Not pushed / not merged** to remote. Track A (W06 provider adapter) is out of scope on this branch — do not import or cherry-pick W06 OpenAI files.

## Cut / scope (explicit)

| In W07 | Out of scope |
| --- | --- |
| VS Code activation, commands, webview panel shell | W06 OpenAI-compatible provider |
| Stdio bridge + `InProcessHarnessBridge` over existing `ModelProvider` / run protocols | W08 worker isolation |
| FakeProvider offline demo via extension bridge / `demo:extension-offline` | Lim3 / crew file work |
| Credential interface stub (`SecretStorage` / memory) | Marketplace `.vsix` / `package:extension` |
| Reconnect-safe `subscribe_events` (no duplicate start) | Full approval UX / export_handoff |

Composes on main **without** unmerged W06.

## What changed

### Contracts
- `packages/contracts/src/bridge.ts` — versioned bridge request/response schemas + error codes
- `packages/contracts/src/bridge.test.ts`

### Core
- `packages/core/src/bridge.ts` — `InProcessHarnessBridge` (start / cancel / pause / get / subscribe)
- `packages/core/src/bridge.test.ts` — offline FakeProvider + reconnect + cancel
- `packages/core/src/runtime.ts` — `getCurrentRunId()`; cancel/abort after stream → `canceled`

### Providers
- `packages/providers/src/fake-provider.ts` — optional `preDelayMs` for cancel/race tests only

### VS Code extension (`apps/vscode-extension`)
| File | Role |
| --- | --- |
| `src/extension.ts` | Activation, commands, wires credential store + panel |
| `src/panel.ts` | Webview panel shell (timeline + start/cancel) |
| `src/host-client.ts` | Stdio JSON-lines client |
| `src/bridge-host-main.ts` | Host process: bridge + FakeProvider; `--once-offline` |
| `src/credentials.ts` | CredentialStore + VsCode/Memory implementations |
| `src/host-client.test.ts` | IPC offline integration test |
| `src/demo-extension-offline.ts` | Demo entry wrapper |

### Docs
- `docs/decisions/ADR-0006-editor-bridge.md`
- `docs/STATUS.md` — W07 → ready for review (this branch)
- `docs/handoffs/W07-handoff.md`
- this file

## Why
W07 requires a real (minimal) editor integration that talks to the harness over existing contracts, with an offline FakeProvider path and reconnect that does not duplicate a run — independent of Track A W06.

## How to run

```bash
cd /workspace/Harnesses/Harnesses-w07
npm install          # if needed
npm run build
npm run typecheck
npm test
npm run demo:offline
npm run demo:extension-offline
```

## Commands that passed (this session)

| Command | Result |
| --- | --- |
| `npm install` | **pass** — added `@types/vscode`; 0 vulnerabilities |
| `npm run build` | **pass** (`tsc -b`) |
| `npm run typecheck` | **pass** |
| `npm test` | **pass** — contracts/core/policy/providers/storage/tools/worker + vscode host-client IPC + integration (offline + extension-bridge) |
| `npm run demo:offline` | **pass** — `DEMO OK (offline)` |
| `npm run demo:extension-offline` | **pass** — `DEMO EXTENSION-OFFLINE OK` |

Environment: Linux x86_64, Node v20.19.2, npm 9.2.0.

## Residual / FLAGs

1. **FLAG — `.vsix` packaging:** `package:extension` not implemented; F5-from-monorepo expected. Bundling the host for Marketplace would leave the Harnesses repo layout or need a bundler — stop rather than hack; revisit with owner.
2. **FLAG — native diff UX:** panel + `vscode.open` on the edited file; full side-by-side `vscode.diff` against pre-edit snapshot not wired (would need artifact snapshot storage).
3. **FLAG — resume_run / decide_approval / export_handoff:** schemas/commands not fully exposed in W07 bridge (only start/cancel/pause/get/subscribe). Additive later; no parallel API.
4. **FLAG — managed process hardening:** stdio host is unauthenticated local child (dev). Loopback HTTP + auth deferred (ADR-0006 revisit).
5. **No W06 import:** FakeProvider only on this branch; when W06 merges, inject `OpenAICompatibleProvider` behind the same `ModelProvider` without rewriting the bridge.

## Risks / known limitations
- Extension host resolves the bridge host via repo paths + optional `tsx` in dev.
- Credential store is wired but unused by FakeProvider (by design).
- Not “verified complete” until Kevin accepts evidence.

## Confirm
- Scope: **W07 / Track B only** inside `/workspace/Harnesses/Harnesses-w07`
- **Not pushed. Not merged. No PR opened.**
- Did **not** touch `/workspace/Harnesses` (Track A W06 worktree).
