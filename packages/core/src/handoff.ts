import type {
  Checkpoint,
  Event,
  Handoff,
  Run,
  Verification,
} from "@kur3/contracts";
import {
  ESTIMATED_SPENDING_LIMIT_NOTE,
  HandoffSchema,
  SCHEMA_VERSION,
} from "@kur3/contracts";
import { formatSpend } from "./budget.js";

const SECRET_KEY =
  /^(authorization|api[_-]?key|access[_-]?token|secret|password|passwd|credential|private[_-]?key)$/i;

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-proj-[A-Za-z0-9_\-]{6,}\b/g,
  /\bsk-[A-Za-z0-9_\-]{6,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /(api[_-]?key|secret|password|token)\s*[:=]\s*['"]?[^\s'"]+/gi,
];

/** Replace secret-shaped substrings. Does not try to detect every credential. */
export function redactString(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) {
        out[key] = "[REDACTED]";
        continue;
      }
      out[key] = redactValue(child);
    }
    return out;
  }
  return value;
}

function asVerifications(events: Event[]): Verification[] {
  const out: Verification[] = [];
  for (const event of events) {
    if (event.type !== "verification_recorded") continue;
    const p = event.payload;
    if (typeof p.criterionId !== "string" || typeof p.outcome !== "string") continue;
    if (!["passed", "failed", "not_run", "blocked"].includes(p.outcome)) continue;
    out.push({
      criterionId: p.criterionId,
      description: typeof p.description === "string" ? p.description : "",
      outcome: p.outcome as Verification["outcome"],
      evidence: typeof p.evidence === "string" ? redactString(p.evidence) : undefined,
      exitStatus: typeof p.exitStatus === "number" ? p.exitStatus : undefined,
    });
  }
  return out;
}

function artifactsFrom(events: Event[]): Handoff["artifacts"] {
  const artifacts: Handoff["artifacts"] = [];
  for (const event of events) {
    if (event.type !== "tool_finished") continue;
    const result = event.payload.result;
    if (!result || typeof result !== "object") continue;
    const rec = result as Record<string, unknown>;
    if (rec.status !== "applied" && rec.status !== "proposed") continue;
    const callId = typeof event.payload.callId === "string" ? event.payload.callId : event.id;
    artifacts.push({
      id: callId,
      path: typeof rec.path === "string" ? rec.path : undefined,
      contentHash:
        typeof rec.newHash === "string"
          ? rec.newHash
          : typeof rec.previousHash === "string"
            ? rec.previousHash
            : undefined,
      producingEventSequence: event.sequence,
    });
  }
  return artifacts;
}

function decisionsFrom(
  checkpoint: Checkpoint | undefined,
): Handoff["decisions"] {
  const raw = checkpoint?.taskFacts?.decisions;
  if (!Array.isArray(raw)) return [];
  const out: Handoff["decisions"] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.summary !== "string") continue;
    out.push({
      summary: rec.summary,
      reason: typeof rec.reason === "string" ? rec.reason : undefined,
    });
  }
  return out;
}

function nextAction(run: Run, pending: string[]): string {
  if (run.state === "budget_exhausted") {
    return "No new billable request until an explicit estimated spending limit update. This is not a provider billing cap.";
  }
  if (run.state === "paused") {
    return pending.length
      ? "Resume only after pending calls are reconciled. Do not blindly repeat writes."
      : "Resume the run from the checkpoint if the goal is still current.";
  }
  if (run.state === "completed") return "Review verification evidence. No further agent step is queued.";
  if (run.state === "failed" || run.state === "canceled") {
    return "Start a linked new run if the goal remains; do not rewrite this history.";
  }
  if (run.state === "waiting_for_approval") return "Wait for a matching approval before any protected action.";
  return "Reconcile unknown outcomes before any new mutation.";
}

/**
 * Build a portable handoff. File bodies, transcripts, and secret-shaped
 * strings are not included. Artifact entries are references (path + hash).
 */
export function buildHandoff(args: {
  run: Run;
  events: Event[];
  checkpoint?: Checkpoint;
  pendingCallIds?: string[];
  repositoryRevision?: string;
}): Handoff {
  const facts = args.checkpoint?.taskFacts ?? {};
  const goal = typeof facts.goal === "string" ? facts.goal : "";
  const mode = facts.mode === "plan" ? "plan" : "run";
  const scope = Array.isArray(facts.scope)
    ? facts.scope.filter((s): s is string => typeof s === "string")
    : [];
  const pending = args.pendingCallIds ?? args.checkpoint?.pendingCalls ?? [];
  const remaining: string[] = [];
  if (args.run.state !== "completed") {
    remaining.push(`Run state is ${args.run.state}.`);
  }
  if (pending.length) {
    remaining.push(`Pending tool calls: ${pending.join(", ")}.`);
  }
  const verifications = asVerifications(args.events);
  const notPassed = verifications.filter((v) => v.outcome !== "passed");
  if (notPassed.length) {
    remaining.push(
      `Verification not fully passed: ${notPassed.map((v) => v.criterionId).join(", ")}.`,
    );
  }

  const risks = [
    "A summary can omit detail; the event log remains the source of history.",
  ];
  if (args.run.limits.estimatedSpendingLimitUsd !== undefined || args.run.budget) {
    risks.push(
      "In-flight work and unknown prices can exceed the estimated spending limit. It is not a guaranteed provider billing cap.",
    );
  }
  if (pending.length) {
    risks.push("Unresolved tool outcomes must be reconciled before retry.");
  }

  const blockers: string[] = [];
  if (args.run.state === "budget_exhausted") {
    blockers.push("budget_exhausted: no new billable work.");
  }
  if (args.run.state === "waiting_for_approval") {
    blockers.push("waiting_for_approval");
  }

  const budget = args.run.budget;
  const draft = {
    schemaVersion: SCHEMA_VERSION,
    kind: "kur3.handoff" as const,
    runId: args.run.id,
    runState: args.run.state,
    goal,
    scope,
    mode,
    decisions: decisionsFrom(args.checkpoint),
    artifacts: artifactsFrom(args.events),
    verifications,
    remainingWork: remaining,
    blockers,
    risks,
    nextAction: nextAction(args.run, pending),
    budget: {
      note: ESTIMATED_SPENDING_LIMIT_NOTE,
      estimatedLimitUsd:
        budget?.estimatedLimitUsd ?? args.run.limits.estimatedSpendingLimitUsd,
      spentKnownUsd: budget?.spentKnownUsd ?? 0,
      reservedUsd: budget?.reservedUsd ?? 0,
      unknownHeldUsd: budget?.unknownHeldUsd ?? 0,
      spendDisplay: formatSpend(
        budget,
        budget?.estimatedLimitUsd ?? args.run.limits.estimatedSpendingLimitUsd,
      ),
    },
    repositoryRevision: args.repositoryRevision,
    redacted: true as const,
  };

  const redacted = redactValue(draft) as Handoff;
  redacted.redacted = true;
  redacted.kind = "kur3.handoff";
  redacted.budget.note = ESTIMATED_SPENDING_LIMIT_NOTE;
  return HandoffSchema.parse(redacted);
}
