# ADR-0002: Runtime foundation (custom adapter first)

Decision ID and date: ADR-0002 / 2026-09-21  
Question: Adopt Pi, Deep Agents, or a custom loop behind harness interfaces for W02?

## Options considered
1. Adapter over [Pi](https://github.com/earendil-works/pi)
2. Adapter over Deep Agents / LangGraph
3. Small custom TypeScript loop implementing guide §8, kept behind our contracts

## Chosen option or provisional default
**Provisional default: custom lightweight `HarnessRuntime` in `@kur3/core`.**

## Evidence
- Guide §4 foundation selection gate requires a same-task comparison before adopting an upstream runtime. Hands-on Pi / Deep Agents evaluation was **not** performed in this session (no dependency fetch for those frameworks; stay offline-first).
- Guide allows documenting the limitation and making a provisional decision when access/comparison is unavailable.
- A custom loop unblocks W03–W05 (storage, policy, integrated offline demo) without committing the repo to a heavy upstream API.

## Tradeoffs
- More code owned by KUR3; fewer upstream features (delegation, advanced planning).
- Replacing the loop later with a Pi/Deep Agents adapter remains possible if interfaces in `@kur3/contracts` stay stable.
- **Untested alternatives:** Pi and Deep Agents remain labeled untested for this project.

## Affected contracts and modules
`packages/core`, provider/tool interfaces in `packages/contracts`.

## Revisit trigger
- Complete W02 comparison spike with Pi and Deep Agents on the same fake task; measure adapter effort, cancellation, recoverable state, dependency weight, and license.

## Owner decision required, if any
Whether to invest a dedicated spike session in Pi vs Deep Agents before W06, or keep the custom loop through the first extension prototype.
