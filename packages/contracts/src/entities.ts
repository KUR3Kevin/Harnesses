import { z } from "zod";
import { SCHEMA_VERSION } from "./protocol.js";
import {
  RunStateSchema,
  ToolCallLifecycleSchema,
  VerificationOutcomeSchema,
} from "./run-states.js";

export const ProjectSchema = z.object({
  id: z.string().min(1),
  workspaceRoot: z.string().min(1),
  isolationBackend: z.enum(["none", "process", "container"]).default("none"),
  policyRef: z.string().default("default"),
});
export type Project = z.infer<typeof ProjectSchema>;

export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  check: z
    .object({
      type: z.enum(["file_contains", "file_exists", "command"]),
      path: z.string().optional(),
      substring: z.string().optional(),
      command: z.string().optional(),
    })
    .optional(),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const TaskSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  goal: z.string().min(1),
  scope: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).default([]),
  mode: z.enum(["plan", "run"]).default("plan"),
});
export type Task = z.infer<typeof TaskSchema>;

export const RunLimitsSchema = z.object({
  maxToolSteps: z.number().int().positive().default(30),
  maxDurationMs: z.number().int().positive().default(15 * 60 * 1000),
  maxCommandMs: z.number().int().positive().default(60_000),
  maxTransientRetries: z.number().int().nonnegative().default(2),
  maxIdenticalFailures: z.number().int().positive().default(3),
});
export type RunLimits = z.infer<typeof RunLimitsSchema>;

export const RunSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  state: RunStateSchema,
  limits: RunLimitsSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  parentRunId: z.string().optional(),
  toolStepsUsed: z.number().int().nonnegative().default(0),
  lastEventSequence: z.number().int().nonnegative().default(0),
});
export type Run = z.infer<typeof RunSchema>;

export const EventTypeSchema = z.enum([
  "run_started",
  "run_state_changed",
  "model_text_delta",
  "model_completed",
  "tool_prepared",
  "tool_started",
  "tool_finished",
  "tool_denied",
  "checkpoint_saved",
  "verification_recorded",
  "error",
  "usage",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const EventSchema = z.object({
  schemaVersion: z.string().default(SCHEMA_VERSION),
  id: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  type: EventTypeSchema,
  timestamp: z.string().datetime(),
  payload: z.record(z.unknown()).default({}),
  artifactRef: z.string().optional(),
});
export type Event = z.infer<typeof EventSchema>;

export const ToolCallSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.unknown()),
  inputDigest: z.string().min(1),
  policyDecision: z.enum(["allow", "deny", "require_approval"]),
  lifecycle: ToolCallLifecycleSchema,
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const CheckpointSchema = z.object({
  runId: z.string().min(1),
  runState: RunStateSchema,
  lastEventSequence: z.number().int().nonnegative(),
  taskFacts: z.record(z.unknown()).default({}),
  pendingCalls: z.array(z.string()).default([]),
  workspaceRevision: z.string().optional(),
  savedAt: z.string().datetime(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const VerificationSchema = z.object({
  criterionId: z.string().min(1),
  description: z.string(),
  outcome: VerificationOutcomeSchema,
  evidence: z.string().optional(),
  exitStatus: z.number().int().optional(),
});
export type Verification = z.infer<typeof VerificationSchema>;

export const UsageSchema = z.object({
  requestId: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  priceVersion: z.string().optional(),
  completeness: z.enum(["complete", "partial", "unknown"]).default("unknown"),
});
export type Usage = z.infer<typeof UsageSchema>;
