import { z } from "zod";
import { HandoffSchema } from "./handoff.js";
import { SCHEMA_VERSION } from "./protocol.js";
import { ProviderMessageSchema } from "./provider.js";

/**
 * W10 portable checkpoint (guide §9). Provider-neutral facts used to move a
 * run to another provider at a clean boundary. Contains only portable
 * `ProviderMessage` fields and allow-listed task facts — never another
 * provider's opaque state (reasoning blocks, signatures, cache handles,
 * response ids, raw wire payloads).
 */
export const PortableCheckpointSchema = z.object({
  schemaVersion: z.string().default(SCHEMA_VERSION),
  kind: z.literal("kur3.portable_checkpoint"),
  runId: z.string().min(1),
  fromProviderId: z.string().min(1),
  fromModelId: z.string().min(1),
  lastEventSequence: z.number().int().nonnegative(),
  /** Allow-listed facts only (goal, scope, mode, decisions, criteria, ...). */
  taskFacts: z.record(z.unknown()),
  /**
   * The SMALL verified handoff conversation the new provider starts from
   * (system preamble + one continuation turn). The prior provider's full
   * conversation is NOT inherited (owner decision, W10 review).
   */
  transcript: z.array(ProviderMessageSchema.strict()),
  handoff: HandoffSchema,
  /** Keys / message fields removed during conversion (names only, no values). */
  dropped: z.array(z.string()),
  /** What the handoff was verified against at switch time. */
  verifiedAgainst: z.object({
    runState: z.string().min(1),
    taskId: z.string().min(1),
    checkpointSequence: z.number().int().nonnegative(),
    ledgerCalls: z.number().int().nonnegative(),
  }),
  /** sha256 over the canonical {runId, sequence, taskFacts, handoff, transcript}. */
  handoffDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type PortableCheckpoint = z.infer<typeof PortableCheckpointSchema>;
