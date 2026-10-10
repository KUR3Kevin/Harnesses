import type {
  BudgetSnapshot,
  Checkpoint,
  Event,
  ModelProvider,
  PortableCheckpoint,
  ProviderMessage,
  Run,
  ToolCall,
} from "@kur3/contracts";
import { PortableCheckpointSchema, SCHEMA_VERSION } from "@kur3/contracts";
import { buildHandoff, redactValue } from "./handoff.js";

/**
 * W10 provider switching (guide §9, A15).
 *
 * Switch only at a clean boundary: a checkpoint exists, no tool call is
 * pending or outcome-unknown, and no budget reservation is in flight.
 * Only portable messages and allow-listed facts move; another provider's
 * opaque state is stripped, never forwarded.
 */

/** Task facts that are provider-neutral and may cross a switch. */
export const PORTABLE_TASK_FACT_KEYS = [
  "taskId",
  "goal",
  "mode",
  "scope",
  "acceptanceCriteria",
  "decisions",
  "startedAtMs",
  "remainingWork",
  "providerSwitches",
] as const;

const PENDING_LIFECYCLES = new Set(["prepared", "running", "outcome_unknown"]);
const MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);

export type SwitchRefusal =
  | "no_checkpoint"
  | "checkpoint_run_mismatch"
  | "pending_tool_calls"
  | "reservation_in_flight"
  | "run_active"
  | "same_provider";

export type SwitchResult =
  | {
      ok: true;
      portable: PortableCheckpoint;
      checkpoint: Checkpoint;
      run: Run;
      /** Ready-to-send portable request messages for the new provider. */
      messages: ProviderMessage[];
    }
  | { ok: false; reason: SwitchRefusal; detail: string };

function sanitizeTranscript(raw: unknown, dropped: Set<string>): ProviderMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ProviderMessage[] = [];
  raw.forEach((item, i) => {
    if (!item || typeof item !== "object") {
      dropped.add(`transcript[${i}]`);
      return;
    }
    const rec = item as Record<string, unknown>;
    if (!MESSAGE_ROLES.has(rec.role as string) || typeof rec.content !== "string") {
      // Unsupported message type (e.g. provider-native reasoning / content blocks).
      dropped.add(`transcript[${i}]:unsupported`);
      return;
    }
    for (const key of Object.keys(rec)) {
      if (!["role", "content", "name", "toolCallId"].includes(key)) {
        dropped.add(`transcript.${key}`);
      }
    }
    const msg: ProviderMessage = {
      role: rec.role as ProviderMessage["role"],
      content: rec.content,
    };
    if (typeof rec.name === "string") msg.name = rec.name;
    if (typeof rec.toolCallId === "string") msg.toolCallId = rec.toolCallId;
    out.push(msg);
  });
  return redactValue(out) as ProviderMessage[];
}

/** Convert a saved checkpoint into provider-neutral form. Pure; no I/O. */
export function toPortableCheckpoint(args: {
  run: Run;
  checkpoint: Checkpoint;
  events: Event[];
  repositoryRevision?: string;
}): PortableCheckpoint {
  const dropped = new Set<string>();
  const facts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args.checkpoint.taskFacts ?? {})) {
    if (key === "transcript") continue;
    if ((PORTABLE_TASK_FACT_KEYS as readonly string[]).includes(key)) {
      facts[key] = value;
    } else {
      dropped.add(`taskFacts.${key}`);
    }
  }
  const transcript = sanitizeTranscript(args.checkpoint.taskFacts?.transcript, dropped);
  const handoff = buildHandoff({
    run: args.run,
    events: args.events,
    checkpoint: args.checkpoint,
    pendingCallIds: args.checkpoint.pendingCalls,
    repositoryRevision: args.repositoryRevision ?? args.checkpoint.workspaceRevision,
  });
  return PortableCheckpointSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    kind: "kur3.portable_checkpoint",
    runId: args.run.id,
    fromProviderId: args.run.providerId,
    fromModelId: args.run.modelId,
    lastEventSequence: args.checkpoint.lastEventSequence,
    taskFacts: redactValue(facts) as Record<string, unknown>,
    transcript,
    handoff,
    dropped: [...dropped].sort(),
  });
}

/**
 * Render portable facts as a leading system message so the new provider gets
 * goal, decisions, artifacts and check evidence even if transcript is short.
 */
export function handoffPreamble(p: PortableCheckpoint): string {
  const h = p.handoff;
  const lines = [
    `Provider switch handoff (from ${p.fromProviderId}/${p.fromModelId}).`,
    `Goal: ${h.goal}`,
    `Scope: ${h.scope.join(", ") || "(none)"}`,
    `Mode: ${h.mode}`,
  ];
  if (h.repositoryRevision) lines.push(`Repository revision: ${h.repositoryRevision}`);
  for (const d of h.decisions) lines.push(`Decision: ${d.summary}${d.reason ? ` — because ${d.reason}` : ""}`);
  for (const a of h.artifacts) lines.push(`Artifact: ${a.path ?? a.id}${a.contentHash ? ` @ ${a.contentHash}` : ""}`);
  for (const v of h.verifications) {
    lines.push(`Check ${v.criterionId}: ${v.outcome}${v.evidence ? ` — ${v.evidence}` : ""}`);
  }
  for (const r of h.remainingWork) lines.push(`Remaining: ${r}`);
  for (const b of h.blockers) lines.push(`Blocker: ${b}`);
  for (const r of h.risks) lines.push(`Risk: ${r}`);
  lines.push(`Next action: ${h.nextAction}`);
  return lines.join("\n");
}

/**
 * Switch a run to another provider at a clean boundary. Pure: returns the
 * new run/checkpoint for the caller to persist. Refuses rather than guessing.
 */
export function switchProvider(args: {
  run: Run;
  checkpoint: Checkpoint | undefined;
  events: Event[];
  toolCalls?: ToolCall[];
  to: ModelProvider;
  toModelId: string;
  repositoryRevision?: string;
  now?: () => string;
}): SwitchResult {
  const { run, checkpoint } = args;
  if (!checkpoint) {
    return { ok: false, reason: "no_checkpoint", detail: "Save a checkpoint before switching providers." };
  }
  if (checkpoint.runId !== run.id) {
    return { ok: false, reason: "checkpoint_run_mismatch", detail: `Checkpoint is for ${checkpoint.runId}.` };
  }
  if (run.state === "running") {
    return { ok: false, reason: "run_active", detail: "Pause or finish the run before switching." };
  }
  const pending = new Set(checkpoint.pendingCalls);
  for (const call of args.toolCalls ?? []) {
    if (call.runId === run.id && PENDING_LIFECYCLES.has(call.lifecycle)) pending.add(call.id);
  }
  if (pending.size > 0) {
    return {
      ok: false,
      reason: "pending_tool_calls",
      detail: `Resolve pending or unknown tool calls first: ${[...pending].join(", ")}.`,
    };
  }
  if ((run.budget?.reservedUsd ?? 0) > 0) {
    return {
      ok: false,
      reason: "reservation_in_flight",
      detail: "A budget reservation is not reconciled. Settle it before switching.",
    };
  }
  if (args.to.id === run.providerId && args.toModelId === run.modelId) {
    return { ok: false, reason: "same_provider", detail: "Already on this provider and model." };
  }

  const portable = toPortableCheckpoint({
    run,
    checkpoint,
    events: args.events,
    repositoryRevision: args.repositoryRevision,
  });
  const now = (args.now ?? (() => new Date().toISOString()))();

  const switches = Array.isArray(portable.taskFacts.providerSwitches)
    ? [...(portable.taskFacts.providerSwitches as unknown[])]
    : [];
  switches.push({
    from: `${run.providerId}/${run.modelId}`,
    to: `${args.to.id}/${args.toModelId}`,
    at: now,
    atEventSequence: checkpoint.lastEventSequence,
  });

  const messages: ProviderMessage[] = [
    { role: "system", content: handoffPreamble(portable) },
    ...portable.transcript,
  ];

  // Budget: spend already recorded stays on the run; a reservation never
  // crosses (guarded above). New provider starts with reservedUsd = 0.
  const budget: BudgetSnapshot | undefined = run.budget
    ? { ...run.budget, reservedUsd: 0 }
    : undefined;

  const newCheckpoint: Checkpoint = {
    runId: run.id,
    runState: run.state,
    lastEventSequence: checkpoint.lastEventSequence,
    taskFacts: { ...portable.taskFacts, providerSwitches: switches, transcript: portable.transcript },
    pendingCalls: [],
    workspaceRevision: checkpoint.workspaceRevision,
    savedAt: now,
  };
  const newRun: Run = {
    ...run,
    providerId: args.to.id,
    modelId: args.toModelId,
    updatedAt: now,
    ...(budget ? { budget } : {}),
  };
  return { ok: true, portable, checkpoint: newCheckpoint, run: newRun, messages };
}
