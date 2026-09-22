# ADR-0006: Editor bridge transport (stdio IPC + in-process core)

Decision ID and date: ADR-0006 / 2026-09-22  
Question: How should the VS Code extension talk to `@kur3/core` for W07 without coupling to W06 providers or freezing the editor host?

## Options considered
1. Import `@kur3/core` directly inside the extension host process (in-process only)
2. Versioned JSON-lines over stdio to a small bridge-host process that owns `InProcessHarnessBridge`
3. Local HTTP loopback service

## Chosen option or provisional default
**Option 2 (provisional): stdio JSON-lines IPC to `bridge-host-main`, which runs `InProcessHarnessBridge` + injected `ModelProvider`.**

The bridge request/response schemas live in `@kur3/contracts` (`BRIDGE_PROTOCOL_VERSION` = protocol `0.1.0`) and match Master Build Guide §7 commands used in W07: `start_run`, `cancel_run`, `pause_run`, `get_run`, `subscribe_events`.

## Evidence
- Guide §5/§7: managed process + versioned messaging; UI reconnect must not create another run.
- Monorepo packages are ESM; VS Code extension host loading is simpler when the extension process stays on VS Code APIs + a thin stdio client.
- Offline FakeProvider path must work without network and without W06 adapters.

## Tradeoffs
- Two processes to reason about in F5 debug; host must resolve workspace dependencies (dev from repo).
- HTTP not chosen yet (would need loopback auth).
- Pure in-process remains available via `InProcessHarnessBridge` for unit tests and `demo:extension-offline`.

## Affected contracts and modules
`packages/contracts` (bridge schemas), `packages/core` (`InProcessHarnessBridge`), `apps/vscode-extension` (panel, host client, host main).

## Revisit trigger
- Packaging a `.vsix` that must ship a self-contained host (bundle or install layout)
- Moving to authenticated loopback HTTP
- W08 isolation requiring a stricter worker boundary

## Owner decision required, if any
None for W07 offline prototype. Confirm before Marketplace publishing.
