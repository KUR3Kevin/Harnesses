# ADR-0001: Environment and tooling defaults

Decision ID and date: ADR-0001 / 2026-09-21  
Question: What runtime, package manager, and language stack should the first scaffold use?

## Options considered
1. TypeScript monorepo with npm workspaces
2. TypeScript monorepo with pnpm
3. Python-first harness core
4. Defer scaffold until owner answers all open product questions

## Chosen option or provisional default
**Provisional default: TypeScript monorepo with npm workspaces**, Node.js ≥ 20.

## Evidence
- Builder environment verified on this box: Linux x86_64, Node v20.19.2, npm 9.2.0, git present.
- `pnpm` / `yarn` were not available on PATH during W00; installing another package manager was unnecessary for the offline milestone.
- Master Build Guide §5–§6 recommend TypeScript for runtime and extension, one package manager and lockfile.

## Tradeoffs
- npm workspaces are widely available but slower/heavier than pnpm for large trees.
- Pinning exact dependency versions happens at first `npm install`; versions in package.json use caret ranges and must be treated as provisional until the lockfile is reviewed.

## Affected contracts and modules
Root `package.json`, all `packages/*` and `apps/*`.

## Revisit trigger
- Owner requires pnpm/yarn; CI needs stricter pinning; Node major upgrade.

## Owner decision required, if any
Confirm package manager (npm vs pnpm) and whether Node 20 is the minimum supported version for contributors.
