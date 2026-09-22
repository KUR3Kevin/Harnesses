# KUR3 Harness

Open-source AI coding harness scaffold (offline-first). Engine is independent of the editor; a VS Code extension panel + stdio bridge lands in W07.

**Status:** Step 2 Track B — W07 editor integration (this branch). See [`docs/STATUS.md`](docs/STATUS.md) and [`docs/STEP2-W07-CHANGE-SUMMARY.md`](docs/STEP2-W07-CHANGE-SUMMARY.md).

Authoritative plan: [`KUR3-Harness-Master-Build-Guide.md`](KUR3-Harness-Master-Build-Guide.md).

## Prerequisites

- Node.js ≥ 20 (verified: v20.19.2)
- npm ≥ 9 (verified: 9.2.0)

## Setup

```bash
npm install
```

## Commands

```bash
npm run build
npm run typecheck
npm test
npm run demo:offline
npm run demo:extension-offline
```

`demo:offline` and `demo:extension-offline` use a deterministic fake provider. No API keys. No network required for the demo path.

## Layout

| Path | Role |
| --- | --- |
| `packages/contracts` | Schemas, run states, provider/tool interfaces |
| `packages/core` | Single-run orchestration |
| `packages/providers` | Fake provider (real providers later) |
| `packages/policy` | Tool policy + path boundary |
| `packages/tools` | Tool definitions + executor |
| `packages/worker` | File worker (not a full sandbox) |
| `packages/storage` | Durable runs/events/checkpoints/leases |
| `apps/cli` | Developer CLI + offline demo |
| `apps/vscode-extension` | Panel, commands, stdio bridge (W07) |
| `docs/decisions` | ADRs |
| `docs/handoffs` | Builder handoffs |

## License

Not selected yet (open owner question). Do not publish until LICENSE is chosen.
