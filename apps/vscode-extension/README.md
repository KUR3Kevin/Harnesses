# KUR3 Harness VS Code extension (W07)

Minimal editor integration: activation, commands, webview panel shell, and a
stdio bridge to `@kur3/core` + `FakeProvider` (offline).

## Commands

| Command | Title |
| --- | --- |
| `kur3.openPanel` | KUR3: Open Harness Panel |
| `kur3.startOfflineDemo` | KUR3: Start Offline Demo Run |
| `kur3.cancelRun` | KUR3: Cancel Active Run |

## Offline demo (no VS Code UI required)

From the monorepo root:

```bash
npm run demo:extension-offline
```

This runs the same bridge host path the extension uses (`bridge-host-main --once-offline`).

## Architecture

- Extension host: VS Code API + `BridgeHostClient` (JSON lines over stdio)
- Bridge host process: `InProcessHarnessBridge` + `FakeProvider`
- Shared contracts: `BRIDGE_PROTOCOL_VERSION` / guide §7 commands

Reconnect: `subscribe_events` resumes after a sequence number and never starts a run.

## Not in W07

- Marketplace / `.vsix` packaging (`package:extension`)
- Real provider credentials beyond the SecretStorage interface stub
- W06 OpenAI adapter (Track A — do not import)
- W08 worker isolation
