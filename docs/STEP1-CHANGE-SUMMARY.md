# Step 1 change summary (for Kevin)

Date: 2026-09-21 (PT)  
Repo: `/workspace/Harnesses` (GitHub: KUR3Kevin/Harnesses)  
Scope: Master Build Guide work packages **W00–W05** offline scaffold  
**Not pushed / not merged** to remote.

## What changed

### Documentation
- `docs/decisions/ADR-0001-environment-and-tooling.md` — npm workspaces + Node 20 provisional
- `docs/decisions/ADR-0002-runtime-foundation.md` — custom `HarnessRuntime` provisional; Pi/Deep Agents **not** compared
- `docs/decisions/ADR-0003-storage-backend.md` — JSON `RunStore` provisional; SQLite later
- `docs/decisions/ADR-0004-open-questions.md` — owner questions vs builder defaults
- `docs/STATUS.md` — W00–W12 table
- `docs/handoffs/W00-W05-handoff.md` — builder handoff
- `README.md` — setup and commands

### Monorepo packages created
| Package | Role |
| --- | --- |
| `@kur3/contracts` | Zod schemas, run states, provider/tool interfaces |
| `@kur3/providers` | `FakeProvider` (deterministic offline) |
| `@kur3/policy` | Plan/Run tool policy + workspace path guard |
| `@kur3/tools` | `read_file`, `search_files`, `propose_patch`, `apply_patch` |
| `@kur3/worker` | Path-checked file worker + content hash / patch conflict |
| `@kur3/storage` | Durable runs, ordered events, checkpoints, run lease |
| `@kur3/core` | Single-run orchestration loop |
| `@kur3/cli` | `demo:offline` entry |
| `kur3-harness` (apps/vscode-extension) | **Stub only** (W07) |

Also: `fixtures/demo-project`, `tests/integration/offline-demo.test.ts`, root npm workspaces + `package-lock.json`.

## How to run

```bash
cd /workspace/Harnesses   # or your clone
npm install
npm run build
npm run typecheck
npm test
npm run demo:offline
```

Prerequisites verified on builder: **Linux x86_64, Node v20.19.2, npm 9.2.0**.

## Commands that passed (this session)

| Command | Result (summary) |
| --- | --- |
| `npm install` | OK — lockfile written; 0 vulnerabilities reported |
| `npm run build` | OK — `tsc -b` clean |
| `npm run typecheck` | OK — `tsc -b --pretty false` clean |
| `npm test` | OK — unit suites across contracts/providers/policy/tools/worker/storage/core + 2 integration tests; **0 failures** |
| `npm run demo:offline` | OK — printed `DEMO OK (offline)`; edited fixture to `hello, kur3`; verification `passed` |

Exact demo excerpt:
- Before: `return "hello"`
- After: `return "hello, kur3"`
- Run state: `completed`
- Events recorded: 19

## What is unverified / not claimed

- Full acceptance matrix A06–A11, A13–A20 **not** run or claimed
- Live providers / `test:live` **not** run (no keys; intentional)
- Lint / format pipeline **not** configured
- Pi vs Deep Agents comparison **not** performed (ADR-0002)
- SQLite persistence **not** implemented (JSON provisional)
- VS Code panel / bridge **not** implemented (stub)
- `run_command` / isolated worker **disabled** until W08
- File worker is **not** a sandbox (path boundary only)
- Remote push / PR merge **not** done
- Cross-OS matrix beyond this Linux builder **not** tested
- “Network fully disabled at OS level” not separately proven; demo uses FakeProvider with no network I/O

Statuses in `docs/STATUS.md` are **ready for review**, not **verified complete**.

## What’s next (W06+)

1. Kevin reviews this summary + ADRs (especially open questions in ADR-0004).
2. **W06** — first real provider adapter behind mocks; live smoke only if credentials + budget supplied.
3. Optional: foundation spike to replace provisional custom runtime (ADR-0002 revisit).
4. **W07** — real VS Code extension (panel, bridge, diffs).
5. Later: W08 worker isolation, W09 recovery/budget, W10 second provider.

## Blockers / residual risks

- Owner product questions still open (shipping format, OS matrix, license, auto-approve policy, live budget).
- JSON store may need SQLite before multi-process / large event volume.
- Without W08, do not enable autonomous shell tools.
- Extension stub must not be mistaken for a working editor integration.

## Exact next action after Kevin reviews

Approve Step 1 locally (optional: Kevin commits/pushes), then open a **W06-only** assignment: mocked conformance tests for one real provider interface; no paid calls unless Kevin supplies credentials and a small budget.
