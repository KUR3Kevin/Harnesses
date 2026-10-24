import { createHash } from "node:crypto";
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
import { buildHandoff, redactString, redactValue } from "./handoff.js";

/**
 * W10 provider switching (guide §9, A15), hardened after the PR #7 review.
 *
 * Switch only at a verified clean boundary:
 * - the checkpoint is for this run AND covers the latest event
 *   (`checkpoint.lastEventSequence === run.lastEventSequence`), was saved in
 *   the run's current state, and is for the run's task;
 * - the tool-call ledger is supplied (a missing ledger is a refusal, never a
 *   bypass) and agrees with the event log; no call is pending/unknown;
 * - no budget reservation is in flight.
 *
 * Handoff (owner decision): a SMALL verified conversation handoff — task facts
 * plus a verified summary of state and checkpoint — NOT the previous
 * provider's full conversation. Only allow-listed, redacted facts move; opaque
 * provider state is never forwarded. The result is validated (required facts
 * present, no secret-shaped strings, digest matches) before it is returned.
 *
 * This module is pure. `HarnessRuntime.switchProvider` adds the lease,
 * atomic persistence and request-id idempotency.
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

/** Facts the new provider cannot work without. */
export const REQUIRED_HANDOFF_FACTS = ["taskId", "goal", "mode"] as const;

const PENDING_LIFECYCLES = new Set(["prepared", "running", "outcome_unknown"]);
const SWITCHABLE_STATES = new Set(["paused", "budget_exhausted"]);

export type SwitchRefusal =
  | "no_checkpoint"
  | "checkpoint_run_mismatch"
  | "stale_checkpoint"
  | "checkpoint_state_mismatch"
  | "task_mismatch"
  | "ledger_unavailable"
  | "ledger_mismatch"
  | "pending_tool_calls"
  | "reservation_in_flight"
  | "run_active"
  | "run_not_switchable"
  | "same_provider"
  | "handoff_invalid";

export type SwitchResult =
  | {
      ok: true;
      portable: PortableCheckpoint;
      checkpoint: Checkpoint;
      run: Run;
      /** Ready-to-send small handoff messages for the new provider. */
      messages: ProviderMessage[];
    }
  | { ok: false; reason: SwitchRefusal; detail: string };

function refuse(reason: SwitchRefusal, detail: string): SwitchResult {
  return { ok: false, reason, detail };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec)
      .filter((k) => rec[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(rec[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function handoffDigest(p: Pick<PortableCheckpoint, "runId" | "lastEventSequence" | "taskFacts" | "handoff" | "transcript">): string {
  const body = canonical({
    runId: p.runId,
    lastEventSequence: p.lastEventSequence,
    taskFacts: p.taskFacts,
    handoff: p.handoff,
    transcript: p.transcript,
  });
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

/**
 * Render portable facts as a leading system message so the new provider gets
 * goal, decisions, artifacts and check evidence without the old transcript.
 */
export function handoffPreamble(p: Pick<PortableCheckpoint, "fromProviderId" | "fromModelId" | "handoff" | "taskFacts" | "lastEventSequence">): string {
  const h = p.handoff;
  const lines = [
    `Provider switch handoff (from ${p.fromProviderId}/${p.fromModelId}).`,
    `Verified at checkpoint event ${p.lastEventSequence}; run state ${h.runState}; task ${String(p.taskFacts.taskId)}.`,
    "The previous conversation is not included; continue from these verified facts and re-read files you need.",
    `Goal: ${h.goal}`,
    `Scope: ${h.scope.join(", ") || "(none)"}`,
    `Mode: ${h.mode}`,
  ];
  if (h.repositoryRevision) lines.push(`Repository revision: ${h.repositoryRevision}`);
  const criteria = Array.isArray(p.taskFacts.acceptanceCriteria) ? p.taskFacts.acceptanceCriteria : [];
  for (const c of criteria) {
    if (c && typeof c === "object" && typeof (c as { id?: unknown }).id === "string") {
      const rec = c as { id: string; description?: unknown };
      lines.push(`Acceptance ${rec.id}: ${typeof rec.description === "string" ? rec.description : ""}`);
    }
  }
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

function continuationTurn(p: Pick<PortableCheckpoint, "handoff">): string {
  return `Continue the task "${p.handoff.goal}" from the verified handoff. Use tools to inspect current workspace state before changing anything.`;
}

/** Convert a saved checkpoint into provider-neutral form. Pure; no I/O. */
export function toPortableCheckpoint(args: {
  run: Run;
  checkpoint: Checkpoint;
  events: Event[];
  toolCalls?: ToolCall[];
  repositoryRevision?: string;
}): PortableCheckpoint {
  const dropped = new Set<string>();
  const facts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args.checkpoint.taskFacts ?? {})) {
    if (key === "transcript") {
      const n = Array.isArray(value) ? value.length : 0;
      dropped.add(`transcript:not_inherited(${n})`);
      continue;
    }
    if ((PORTABLE_TASK_FACT_KEYS as readonly string[]).includes(key)) {
      facts[key] = value;
    } else {
      dropped.add(`taskFacts.${key}`);
    }
  }
  const handoff = buildHandoff({
    run: args.run,
    events: args.events,
    checkpoint: args.checkpoint,
    pendingCallIds: args.checkpoint.pendingCalls,
    repositoryRevision: args.repositoryRevision ?? args.checkpoint.workspaceRevision,
  });
  const taskFacts = redactValue(facts) as Record<string, unknown>;
  const partial = {
    fromProviderId: args.run.providerId,
    fromModelId: args.run.modelId,
    lastEventSequence: args.checkpoint.lastEventSequence,
    taskFacts,
    handoff,
  };
  const transcript = redactValue([
    { role: "system", content: handoffPreamble(partial) },
    { role: "user", content: continuationTurn(partial) },
  ]) as ProviderMessage[];
  const draft = {
    schemaVersion: SCHEMA_VERSION,
    kind: "kur3.portable_checkpoint" as const,
    runId: args.run.id,
    ...partial,
    transcript,
    dropped: [...dropped].sort(),
    verifiedAgainst: {
      runState: args.run.state,
      taskId: args.run.taskId,
      checkpointSequence: args.checkpoint.lastEventSequence,
      ledgerCalls: args.toolCalls?.length ?? 0,
    },
  };
  return PortableCheckpointSchema.parse({ ...draft, handoffDigest: handoffDigest(draft) });
}

/**
 * Validate a portable handoff before a provider sees it: required task facts
 * present, nothing secret-shaped left anywhere, digest matches content.
 * Returns problems (empty = valid).
 */
export function verifyPortableCheckpoint(p: PortableCheckpoint): string[] {
  const problems: string[] = [];
  const parsed = PortableCheckpointSchema.safeParse(p);
  if (!parsed.success) return [`schema: ${parsed.error.issues[0]?.message ?? "invalid"}`];
  for (const key of REQUIRED_HANDOFF_FACTS) {
    const v = p.taskFacts[key];
    if (typeof v !== "string" || v.trim() === "") problems.push(`missing task fact: ${key}`);
  }
  if (p.taskFacts.taskId !== undefined && p.taskFacts.taskId !== p.verifiedAgainst.taskId) {
    problems.push("taskFacts.taskId does not match the verified task");
  }
  if (p.lastEventSequence !== p.verifiedAgainst.checkpointSequence) {
    problems.push("checkpoint sequence does not match the verified sequence");
  }
  const scan = (value: unknown, where: string): void => {
    if (typeof value === "string") {
      if (redactString(value) !== value) problems.push(`unredacted secret-shaped value at ${where}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => scan(v, `${where}[${i}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) scan(v, `${where}.${k}`);
    }
  };
  scan(p.taskFacts, "taskFacts");
  scan(p.handoff, "handoff");
  scan(p.transcript, "transcript");
  if (handoffDigest(p) !== p.handoffDigest) problems.push("handoff digest mismatch (tampered or stale)");
  return problems;
}

function checkLedger(run: Run, checkpoint: Checkpoint, events: Event[], ledger: ToolCall[]): SwitchResult | undefined {
  const byId = new Map<string, ToolCall>();
  for (const call of ledger) {
    if (call.runId !== run.id) {
      return refuse("ledger_mismatch", `Ledger entry ${call.id} belongs to run ${call.runId}.`);
    }
    byId.set(call.id, call);
  }
  for (const e of events) {
    if (e.runId !== run.id) continue;
    if (e.type !== "tool_started" && e.type !== "tool_finished") continue;
    const callId = e.payload.callId;
    if (typeof callId === "string" && !byId.has(callId)) {
      return refuse("ledger_mismatch", `Event ${e.sequence} (${e.type}) references ${callId}, which is not in the ledger.`);
    }
  }
  const pending = new Set(checkpoint.pendingCalls);
  for (const call of ledger) if (PENDING_LIFECYCLES.has(call.lifecycle)) pending.add(call.id);
  if (pending.size > 0) {
    return refuse("pending_tool_calls", `Resolve pending or unknown tool calls first: ${[...pending].join(", ")}.`);
  }
  return undefined;
}

/**
 * Validate a switch at a clean boundary and build the new run/checkpoint.
 * Pure: the caller persists. Refuses rather than guessing.
 * `toolCalls` is REQUIRED: pass the run's ledger (possibly empty). Passing
 * `undefined` is refused as `ledger_unavailable`.
 */
export function switchProvider(args: {
  run: Run;
  checkpoint: Checkpoint | undefined;
  events: Event[];
  toolCalls: ToolCall[] | undefined;
  to: ModelProvider;
  toModelId: string;
  repositoryRevision?: string;
  now?: () => string;
}): SwitchResult {
  const { run, checkpoint } = args;
  if (!checkpoint) return refuse("no_checkpoint", "Save a checkpoint before switching providers.");
  if (checkpoint.runId !== run.id) {
    return refuse("checkpoint_run_mismatch", `Checkpoint is for ${checkpoint.runId}.`);
  }
  if (run.state === "running") return refuse("run_active", "Pause or finish the run before switching.");
  if (!SWITCHABLE_STATES.has(run.state)) {
    return refuse("run_not_switchable", `Cannot switch a run in state ${run.state}.`);
  }
  if (checkpoint.lastEventSequence !== run.lastEventSequence) {
    return refuse(
      "stale_checkpoint",
      `Checkpoint covers event ${checkpoint.lastEventSequence} but the run is at ${run.lastEventSequence}. Save a fresh checkpoint first.`,
    );
  }
  if (checkpoint.runState !== run.state) {
    return refuse("checkpoint_state_mismatch", `Checkpoint was saved in state ${checkpoint.runState}; run is ${run.state}.`);
  }
  const factTaskId = checkpoint.taskFacts?.taskId;
  if (factTaskId !== run.taskId) {
    return refuse("task_mismatch", `Checkpoint task ${String(factTaskId)} does not match run task ${run.taskId}.`);
  }
  if (!Array.isArray(args.toolCalls)) {
    return refuse("ledger_unavailable", "The tool-call ledger is required to verify a clean boundary.");
  }
  const ledgerProblem = checkLedger(run, checkpoint, args.events, args.toolCalls);
  if (ledgerProblem) return ledgerProblem;
  if ((run.budget?.reservedUsd ?? 0) > 0) {
    return refuse("reservation_in_flight", "A budget reservation is not reconciled. Settle it before switching.");
  }
  if (args.to.id === run.providerId && args.toModelId === run.modelId) {
    return refuse("same_provider", "Already on this provider and model.");
  }

  const portable = toPortableCheckpoint({
    run,
    checkpoint,
    events: args.events,
    toolCalls: args.toolCalls,
    repositoryRevision: args.repositoryRevision,
  });
  const problems = verifyPortableCheckpoint(portable);
  if (problems.length > 0) return refuse("handoff_invalid", problems.join("; "));

  const now = (args.now ?? (() => new Date().toISOString()))();
  const switches = Array.isArray(portable.taskFacts.providerSwitches)
    ? [...(portable.taskFacts.providerSwitches as unknown[])]
    : [];
  switches.push({
    from: `${run.providerId}/${run.modelId}`,
    to: `${args.to.id}/${args.toModelId}`,
    at: now,
    atEventSequence: checkpoint.lastEventSequence,
    handoffDigest: portable.handoffDigest,
  });

  const messages: ProviderMessage[] = portable.transcript.map((m) => ({ ...m }));

  // Budget: spend already recorded stays on the run; a reservation never
  // crosses (guarded above). New provider starts with reservedUsd = 0.
  const budget: BudgetSnapshot | undefined = run.budget ? { ...run.budget, reservedUsd: 0 } : undefined;

  const newCheckpoint: Checkpoint = {
    runId: run.id,
    runState: run.state,
    lastEventSequence: checkpoint.lastEventSequence,
    taskFacts: { ...portable.taskFacts, providerSwitches: switches, transcript: messages },
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
