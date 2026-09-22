# ADR-0003: Storage backend for durable runs

Decision ID and date: ADR-0003 / 2026-09-21  
Question: How should runs, events, checkpoints, and leases persist for the offline prototype?

## Options considered
1. `better-sqlite3` (native)
2. `sql.js` (WASM SQLite)
3. JSON file store with atomic rename + same logical schema
4. In-memory only

## Chosen option or provisional default
**Provisional default: JSON file store (`RunStore` in `@kur3/storage`)** implementing ordered events, checkpoints, and run leases. Intended long-term direction remains SQLite per guide §5.

## Evidence
- Avoided native module compilation risk on first scaffold so `npm install` / tests stay reliable offline.
- Guide requires durable events outside the project workspace, transactional feel, and exclusive resume lease — all implemented at the API level.
- Atomic write via temp file + rename reduces partial-write corruption vs naive overwrite.

## Tradeoffs
- JSON is weaker for concurrent writers and large event volumes than SQLite.
- Not a SQL migration path yet; schema version field is present (`version: 1`) for future migration.

## Affected contracts and modules
`packages/storage`, `packages/core`.

## Revisit trigger
- Multi-process stress; need for SQL queries; packaging for extension/desktop where SQLite is required by acceptance tests A09/A12 at scale.

## Owner decision required, if any
Prefer SQLite now vs keep JSON until W09 recovery hardening.
