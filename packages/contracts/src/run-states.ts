import { z } from "zod";

export const RunStateSchema = z.enum([
  "queued",
  "running",
  "waiting_for_approval",
  "paused",
  "completed",
  "failed",
  "canceled",
  "budget_exhausted",
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const VerificationOutcomeSchema = z.enum([
  "passed",
  "failed",
  "not_run",
  "blocked",
]);
export type VerificationOutcome = z.infer<typeof VerificationOutcomeSchema>;

export const ToolCallLifecycleSchema = z.enum([
  "prepared",
  "running",
  "succeeded",
  "failed",
  "denied",
  "outcome_unknown",
]);
export type ToolCallLifecycle = z.infer<typeof ToolCallLifecycleSchema>;

/** Valid transitions for the initial offline harness. */
export const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ["running", "canceled"],
  running: [
    "waiting_for_approval",
    "paused",
    "completed",
    "failed",
    "canceled",
    "budget_exhausted",
  ],
  waiting_for_approval: ["running", "paused", "canceled", "failed"],
  paused: ["running", "canceled"],
  completed: [],
  failed: [],
  canceled: [],
  budget_exhausted: ["running", "canceled"],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return (RUN_TRANSITIONS[from] as readonly string[]).includes(to);
}
