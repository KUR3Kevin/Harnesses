import type { BudgetSnapshot, ModelPriceTable } from "@kur3/contracts";
import { emptyBudgetSnapshot } from "@kur3/contracts";

const MICRO = 1_000_000;

export function toMicroUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) return Number.NaN;
  return Math.round(usd * MICRO);
}

export function fromMicroUsd(micro: number): number {
  return micro / MICRO;
}

export interface ReservationQuote {
  label: "usd" | "unknown";
  usd?: number;
  /** Why the quote is unknown, or how a USD quote was formed. */
  reason: string;
}

export function estimateInputTokens(
  messages: ReadonlyArray<{ content: string }>,
): number {
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * Reserve estimated input cost plus maximum output cost.
 * Missing prices or max output → label "unknown". Never coerce that to 0.
 */
export function quoteReservation(args: {
  estimatedInputTokens: number;
  maxOutputTokens?: number;
  prices?: Pick<ModelPriceTable, "inputUsdPer1k" | "outputUsdPer1k">;
}): ReservationQuote {
  const prices = args.prices;
  if (
    !prices ||
    prices.inputUsdPer1k === undefined ||
    prices.outputUsdPer1k === undefined ||
    args.maxOutputTokens === undefined ||
    !Number.isFinite(args.estimatedInputTokens) ||
    args.estimatedInputTokens < 0
  ) {
    return {
      label: "unknown",
      reason:
        "price or max output is unknown; reservation is not treated as zero",
    };
  }
  const usd =
    (prices.inputUsdPer1k * args.estimatedInputTokens) / 1000 +
    (prices.outputUsdPer1k * args.maxOutputTokens) / 1000;
  const micro = toMicroUsd(usd);
  if (!Number.isFinite(micro)) {
    return { label: "unknown", reason: "non-finite reservation" };
  }
  return {
    label: "usd",
    usd: fromMicroUsd(micro),
    reason: "estimated input tokens + max output tokens",
  };
}

export function priceReportedUsage(
  prices: Pick<ModelPriceTable, "inputUsdPer1k" | "outputUsdPer1k"> | undefined,
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
): { costLabel: "known" | "unknown"; estimatedCostUsd?: number } {
  if (
    !prices ||
    prices.inputUsdPer1k === undefined ||
    prices.outputUsdPer1k === undefined ||
    usage?.inputTokens === undefined ||
    usage.outputTokens === undefined
  ) {
    return { costLabel: "unknown" };
  }
  const usd =
    (prices.inputUsdPer1k * usage.inputTokens) / 1000 +
    (prices.outputUsdPer1k * usage.outputTokens) / 1000;
  const micro = toMicroUsd(usd);
  if (!Number.isFinite(micro)) return { costLabel: "unknown" };
  return { costLabel: "known", estimatedCostUsd: fromMicroUsd(micro) };
}

export function remainingMicroUsd(
  budget: BudgetSnapshot,
  limitUsd: number,
): number {
  return (
    toMicroUsd(limitUsd) -
    toMicroUsd(budget.spentKnownUsd) -
    toMicroUsd(budget.reservedUsd) -
    toMicroUsd(budget.unknownHeldUsd)
  );
}

/**
 * Decide whether a new billable request may start.
 * No configured limit → allow (nothing to enforce).
 * Unknown quote with a limit → deny (do not treat unknown as zero).
 */
export function assessReservation(args: {
  limitUsd?: number;
  budget: BudgetSnapshot;
  quote: ReservationQuote;
}): { ok: true; reservationUsd?: number } | { ok: false; reason: string } {
  if (args.limitUsd === undefined) {
    return { ok: true };
  }
  if (args.quote.label !== "usd" || args.quote.usd === undefined) {
    return {
      ok: false,
      reason:
        "reservation is unknown; refusing a new request instead of treating cost as zero",
    };
  }
  const remaining = remainingMicroUsd(args.budget, args.limitUsd);
  const need = toMicroUsd(args.quote.usd);
  if (!Number.isFinite(need) || !Number.isFinite(remaining) || need > remaining) {
    return {
      ok: false,
      reason: `reservation ${args.quote.usd} USD exceeds remaining estimated spending limit (${fromMicroUsd(Math.max(0, remaining))} USD remaining)`,
    };
  }
  return { ok: true, reservationUsd: args.quote.usd };
}

export function applyReservation(
  budget: BudgetSnapshot,
  reservationUsd: number,
): BudgetSnapshot {
  return {
    ...budget,
    reservedUsd: fromMicroUsd(
      toMicroUsd(budget.reservedUsd) + toMicroUsd(reservationUsd),
    ),
  };
}

/**
 * A crashed request may have reserved cost without a recorded usage.
 * Move the hold into unknownHeldUsd. Do not refund it as zero.
 */
export function settleDanglingReservation(
  budget: BudgetSnapshot,
): BudgetSnapshot {
  if (budget.reservedUsd <= 0) return budget;
  return {
    ...budget,
    unknownHeldUsd: fromMicroUsd(
      toMicroUsd(budget.unknownHeldUsd) + toMicroUsd(budget.reservedUsd),
    ),
    reservedUsd: 0,
    unknownChargeCount: budget.unknownChargeCount + 1,
    costLabel: "unknown",
  };
}

export function reconcileReservation(args: {
  budget: BudgetSnapshot;
  reservationUsd?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  prices?: ModelPriceTable;
}): {
  budget: BudgetSnapshot;
  costLabel: "known" | "unknown";
  estimatedCostUsd?: number;
} {
  const reservation = args.reservationUsd ?? 0;
  const priced = priceReportedUsage(args.prices, args.usage);
  let reservedMicro = toMicroUsd(args.budget.reservedUsd) - toMicroUsd(reservation);
  if (reservedMicro < 0) reservedMicro = 0;

  if (priced.costLabel !== "known" || priced.estimatedCostUsd === undefined) {
    const budget: BudgetSnapshot = {
      ...args.budget,
      reservedUsd: fromMicroUsd(reservedMicro),
      unknownHeldUsd: fromMicroUsd(
        toMicroUsd(args.budget.unknownHeldUsd) + toMicroUsd(reservation),
      ),
      unknownChargeCount: args.budget.unknownChargeCount + 1,
      costLabel: "unknown",
    };
    return { budget, costLabel: "unknown" };
  }

  const budget: BudgetSnapshot = {
    ...args.budget,
    reservedUsd: fromMicroUsd(reservedMicro),
    spentKnownUsd: fromMicroUsd(
      toMicroUsd(args.budget.spentKnownUsd) + toMicroUsd(priced.estimatedCostUsd),
    ),
    costLabel: args.budget.unknownChargeCount > 0 ? "unknown" : "known",
  };
  return {
    budget,
    costLabel: budget.costLabel,
    estimatedCostUsd: priced.estimatedCostUsd,
  };
}

/**
 * Display string for cumulative cost.
 * Unknown charges are the word "unknown", never a zero dollar amount.
 * No ledger and no limit → "not_configured".
 */
export function formatSpend(
  budget: BudgetSnapshot | undefined,
  limitUsd?: number,
): string {
  if (
    budget &&
    (budget.costLabel === "unknown" ||
      budget.unknownChargeCount > 0 ||
      budget.unknownHeldUsd > 0)
  ) {
    return "unknown";
  }
  if (!budget && limitUsd === undefined) return "not_configured";
  const spent = budget ? fromMicroUsd(toMicroUsd(budget.spentKnownUsd)) : 0;
  return spent.toFixed(6);
}

export function explicitBudgetRaiseAllowsWork(
  state: string,
  budget: BudgetSnapshot | undefined,
): boolean {
  if (state !== "budget_exhausted") return true;
  if (!budget?.exhaustedAt || !budget.limitRaisedAt) return false;
  return budget.limitRaisedAt > budget.exhaustedAt;
}

export function freshBudget(
  limitUsd: number | undefined,
  priceVersion?: string,
): BudgetSnapshot {
  return emptyBudgetSnapshot({
    estimatedLimitUsd: limitUsd,
    priceVersion,
  });
}
