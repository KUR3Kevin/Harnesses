import { z } from "zod";

/**
 * W09 budget wording. This is an estimated spending limit inside the harness.
 * It is not a guaranteed provider billing cap: in-flight work and unknown
 * prices can still exceed the estimate.
 */
export const ESTIMATED_SPENDING_LIMIT_NOTE =
  "estimated spending limit, not a guaranteed provider billing cap" as const;

export const ModelPriceTableSchema = z.object({
  /** Tag for the pricing source and date, e.g. "fixture-2026-10-02". */
  priceVersion: z.string().min(1),
  /** USD per 1,000 input tokens. Omit when the price is unknown — never 0 as a stand-in. */
  inputUsdPer1k: z.number().nonnegative().optional(),
  /** USD per 1,000 output tokens. Omit when unknown. */
  outputUsdPer1k: z.number().nonnegative().optional(),
});
export type ModelPriceTable = z.infer<typeof ModelPriceTableSchema>;

export const BudgetSnapshotSchema = z.object({
  estimatedLimitUsd: z.number().nonnegative().optional(),
  spentKnownUsd: z.number().nonnegative(),
  /** Holds placed before a request and not yet reconciled. */
  reservedUsd: z.number().nonnegative(),
  /**
   * Reservation amounts whose real price or usage could not be priced.
   * Counted against the remaining estimate. Never collapsed to a $0 charge.
   */
  unknownHeldUsd: z.number().nonnegative(),
  unknownChargeCount: z.number().int().nonnegative(),
  costLabel: z.enum(["known", "unknown"]),
  priceVersion: z.string().optional(),
  exhaustedAt: z.string().datetime().optional(),
  /** Set only by an explicit budget update. Required to leave budget_exhausted. */
  limitRaisedAt: z.string().datetime().optional(),
  note: z.literal(ESTIMATED_SPENDING_LIMIT_NOTE),
});
export type BudgetSnapshot = z.infer<typeof BudgetSnapshotSchema>;

export function emptyBudgetSnapshot(args: {
  estimatedLimitUsd?: number;
  priceVersion?: string;
}): BudgetSnapshot {
  return {
    estimatedLimitUsd: args.estimatedLimitUsd,
    spentKnownUsd: 0,
    reservedUsd: 0,
    unknownHeldUsd: 0,
    unknownChargeCount: 0,
    costLabel: "known",
    priceVersion: args.priceVersion,
    note: ESTIMATED_SPENDING_LIMIT_NOTE,
  };
}
