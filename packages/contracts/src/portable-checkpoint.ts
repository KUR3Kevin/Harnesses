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
  transcript: z.array(ProviderMessageSchema.strict()),
  handoff: HandoffSchema,
  /** Keys / message fields removed during conversion (names only, no values). */
  dropped: z.array(z.string()),
});
export type PortableCheckpoint = z.infer<typeof PortableCheckpointSchema>;
