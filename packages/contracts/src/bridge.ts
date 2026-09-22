import { z } from "zod";
import { PROTOCOL_VERSION } from "./protocol.js";
import { EventSchema, RunLimitsSchema, RunSchema, TaskSchema } from "./entities.js";

/**
 * Versioned UI ↔ engine bridge messages (Master Build Guide §7).
 * Shared by the VS Code extension and any future process IPC host.
 * Keep additive and provider-agnostic — do not couple to a specific adapter.
 */

export const BRIDGE_PROTOCOL_VERSION = PROTOCOL_VERSION;

export const BridgeErrorSchema = z.object({
  code: z.enum([
    "invalid_request",
    "protocol_mismatch",
    "run_not_found",
    "run_already_active",
    "no_active_run",
    "internal",
  ]),
  message: z.string(),
});
export type BridgeError = z.infer<typeof BridgeErrorSchema>;

export const StartRunParamsSchema = z.object({
  task: TaskSchema,
  modelId: z.string().optional(),
  limits: RunLimitsSchema.partial().optional(),
  /** Workspace root the engine may touch; required for file tools. */
  workspaceRoot: z.string().min(1),
  /** Durable harness data dir (outside or sibling to workspace). */
  dataDir: z.string().min(1),
  /** Provider id hint; W07 offline path uses FakeProvider regardless. */
  providerId: z.string().default("fake"),
});
export type StartRunParams = z.infer<typeof StartRunParamsSchema>;

export const BridgeRequestSchema = z.discriminatedUnion("command", [
  z.object({
    protocolVersion: z.string(),
    requestId: z.string().min(1),
    command: z.literal("start_run"),
    params: StartRunParamsSchema,
  }),
  z.object({
    protocolVersion: z.string(),
    requestId: z.string().min(1),
    command: z.literal("cancel_run"),
    params: z.object({
      runId: z.string().min(1),
    }),
  }),
  z.object({
    protocolVersion: z.string(),
    requestId: z.string().min(1),
    command: z.literal("get_run"),
    params: z.object({
      runId: z.string().min(1),
    }),
  }),
  z.object({
    protocolVersion: z.string(),
    requestId: z.string().min(1),
    command: z.literal("subscribe_events"),
    params: z.object({
      runId: z.string().min(1),
      /** Exclusive lower bound — reconnect clients resume after this sequence. */
      afterSequence: z.number().int().nonnegative().default(0),
    }),
  }),
  z.object({
    protocolVersion: z.string(),
    requestId: z.string().min(1),
    command: z.literal("pause_run"),
    params: z.object({
      runId: z.string().min(1),
    }),
  }),
]);
export type BridgeRequest = z.infer<typeof BridgeRequestSchema>;

export const BridgeResponseSchema = z.object({
  protocolVersion: z.string(),
  requestId: z.string(),
  ok: z.boolean(),
  error: BridgeErrorSchema.optional(),
  run: RunSchema.optional(),
  events: z.array(EventSchema).optional(),
  /** Present when start_run finished (or was already complete). */
  summary: z.string().optional(),
  activeRunId: z.string().optional(),
});
export type BridgeResponse = z.infer<typeof BridgeResponseSchema>;

export function assertBridgeProtocol(version: string): void {
  if (version !== BRIDGE_PROTOCOL_VERSION) {
    throw Object.assign(new Error(`Protocol mismatch: ${version}`), {
      code: "protocol_mismatch" as const,
    });
  }
}
