import { z } from "zod";
import { ESTIMATED_SPENDING_LIMIT_NOTE } from "./budget.js";
import { VerificationSchema } from "./entities.js";
import { SCHEMA_VERSION } from "./protocol.js";
import { RunStateSchema } from "./run-states.js";

/**
 * Portable handoff (guide §7 export_handoff, §9). Facts and artifact
 * references only — no secrets, no raw chain-of-thought, no provider keys.
 */
export const HandoffSchema = z.object({
  schemaVersion: z.string().default(SCHEMA_VERSION),
  kind: z.literal("kur3.handoff"),
  runId: z.string().min(1),
  runState: RunStateSchema,
  goal: z.string(),
  scope: z.array(z.string()),
  mode: z.enum(["plan", "run"]),
  decisions: z.array(
    z.object({
      summary: z.string(),
      reason: z.string().optional(),
    }),
  ),
  artifacts: z.array(
    z.object({
      id: z.string().min(1),
      path: z.string().optional(),
      contentHash: z.string().optional(),
      producingEventSequence: z.number().int().nonnegative().optional(),
    }),
  ),
  verifications: z.array(VerificationSchema),
  remainingWork: z.array(z.string()),
  blockers: z.array(z.string()),
  risks: z.array(z.string()),
  nextAction: z.string(),
  budget: z.object({
    note: z.literal(ESTIMATED_SPENDING_LIMIT_NOTE),
    estimatedLimitUsd: z.number().nonnegative().optional(),
    spentKnownUsd: z.number().nonnegative(),
    reservedUsd: z.number().nonnegative(),
    unknownHeldUsd: z.number().nonnegative(),
    /** "unknown" when price or usage is unknown. Never "0" in that case. */
    spendDisplay: z.string(),
  }),
  repositoryRevision: z.string().optional(),
  redacted: z.literal(true),
});
export type Handoff = z.infer<typeof HandoffSchema>;
