import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AcceptanceCriterion,
  BudgetSnapshot,
  ModelPriceTable,
  ProviderMessage,
  Run,
  RunLimits,
  Task,
  ToolCall,
  Verification,
} from "@kur3/contracts";
import {
  ESTIMATED_SPENDING_LIMIT_NOTE,
  RunLimitsSchema,
} from "@kur3/contracts";
import { evaluateToolPolicy } from "@kur3/policy";
import { RunStore } from "@kur3/storage";
import { executeTool, toolRegistry } from "@kur3/tools";
import {
  FileWorker,
  contentHash,
  createCommandWorker,
  type CommandWorker,
} from "@kur3/worker";
import type { ModelProvider } from "@kur3/contracts";
import {
  applyReservation,
  assessReservation,
  estimateInputTokens,
  explicitBudgetRaiseAllowsWork,
  freshBudget,
  priceReportedUsage,
  quoteReservation,
  reconcileReservation,
  settleDanglingReservation,
} from "./budget.js";
import { buildHandoff } from "./handoff.js";
import type { Handoff, PortableCheckpoint } from "@kur3/contracts";
import { switchProvider as planProviderSwitch, type SwitchRefusal } from "./provider-switch.js";
import {
  reconcileToolCall,
  type RecoveryStep,
} from "./recovery.js";

export interface RuntimeOptions {
  workspaceRoot: string;
  dataDir: string;
  /** Default provider for new runs. */
  provider: ModelProvider;
  /**
   * Additional providers a run may be switched to. Each turn streams through
   * the provider whose id matches the run's persisted `providerId`.
   */
  providers?: ModelProvider[];
  holderId?: string;
  /** Pricing source used to reserve and reconcile. Omit prices to force "unknown". */
  prices?: ModelPriceTable;
  repositoryRevision?: string;
}

export interface StartRunInput {
  task: Task;
  modelId?: string;
  limits?: Partial<RunLimits>;
}

export interface RunResult {
  run: Run;
  verifications: Verification[];
  summary: string;
}

export interface SwitchProviderInput {
  /** Idempotency key: repeating a committed request id is a no-op. */
  requestId: string;
  toProviderId: string;
  toModelId: string;
  /** Test seam: runs after validation, under the lease, before the commit. */
  beforeCommit?: () => void | Promise<void>;
}

export type SwitchProviderResult =
  | {
      ok: true;
      /** True when this request id was already committed (no change made). */
      idempotent: boolean;
      run: Run;
      portable?: PortableCheckpoint;
      messages?: ProviderMessage[];
    }
  | {
      ok: false;
      reason: SwitchRefusal | "lease_held" | "unknown_run" | "unknown_provider" | "stale_run" | "request_id_conflict";
      detail: string;
      run?: Run;
    };

export interface ResumeResult {
  ok: boolean;
  reason?: string;
  run?: Run;
  actions: RecoveryStep[];
  continued: boolean;
  summary?: string;
  verifications?: Verification[];
}

function digestInput(input: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
}

function nowIso(): string {
  return new Date().toISOString();
}

function copyMessages(messages: ProviderMessage[]): ProviderMessage[] {
  return messages.map((m) => ({ ...m }));
}

/**
 * Single-run orchestration: provider stream → policy → one tool at a time →
 * checkpoint → verification. Custom lightweight adapter (see ADR-0002).
 * W09 adds hash reconciliation, budget reservations, and handoff export.
 */
export class HarnessRuntime {
  private readonly store: RunStore;
  private readonly worker: FileWorker;
  private readonly commandWorker: CommandWorker;
  /** Default provider for new runs; turns resolve by the run's providerId. */
  private readonly provider: ModelProvider;
  private readonly providers = new Map<string, ModelProvider>();
  private readonly holderId: string;
  private readonly prices?: ModelPriceTable;
  private readonly repositoryRevision?: string;
  private readonly tools = toolRegistry();
  private pauseRequested = false;
  private cancelRequested = false;
  private readonly abort = new AbortController();
  private currentRunId: string | null = null;

  constructor(options: RuntimeOptions) {
    this.store = new RunStore(options.dataDir);
    this.worker = new FileWorker({ workspaceRoot: options.workspaceRoot });
    this.commandWorker = createCommandWorker({
      workspaceRoot: options.workspaceRoot,
    });
    this.provider = options.provider;
    this.providers.set(options.provider.id, options.provider);
    for (const p of options.providers ?? []) {
      if (!this.providers.has(p.id)) this.providers.set(p.id, p);
    }
    this.holderId = options.holderId ?? randomUUID();
    this.prices = options.prices;
    this.repositoryRevision = options.repositoryRevision;
  }

  getStore(): RunStore {
    return this.store;
  }

  /** Provider a run's next turn will stream through (by persisted providerId). */
  providerFor(run: Pick<Run, "providerId">): ModelProvider | undefined {
    return this.providers.get(run.providerId);
  }

  /**
   * Switch a run to another registered provider at a verified clean boundary
   * (W10, PR #7 review P0/P1-1/P1-4):
   * - idempotent by `requestId` (a committed id returns `idempotent: true`);
   * - holds a per-request run lease so two switches (or a switch and a live
   *   drive) cannot race — the loser gets `lease_held`;
   * - validates via the pure planner (sequence/state/task/ledger guards and
   *   the small verified handoff);
   * - persists run + checkpoint + `provider_switched` event + idempotency
   *   record in ONE atomic write, re-checking the event sequence on disk.
   * The next turn (resumeRun) streams through the new provider.
   */
  async switchProvider(runId: string, input: SwitchProviderInput): Promise<SwitchProviderResult> {
    this.store.reload();
    const already = this.store.getProviderSwitch(input.requestId);
    if (already) return this.idempotentSwitch(runId, input, already);

    const holder = `${this.holderId}:switch:${input.requestId}`;
    const lease = this.store.acquireLease(runId, holder);
    if (!lease.ok) {
      const unknown = lease.reason.startsWith("Unknown run");
      return {
        ok: false,
        reason: unknown ? "unknown_run" : "lease_held",
        detail: lease.reason,
        run: this.store.getRun(runId),
      };
    }
    try {
      const raced = this.store.getProviderSwitch(input.requestId);
      if (raced) return this.idempotentSwitch(runId, input, raced);
      const run = this.store.getRun(runId)!;
      const to = this.providers.get(input.toProviderId);
      if (!to) {
        return { ok: false, reason: "unknown_provider", detail: `Provider ${input.toProviderId} is not registered.`, run };
      }
      const plan = planProviderSwitch({
        run,
        checkpoint: this.store.getCheckpoint(runId),
        events: this.store.listEvents(runId),
        toolCalls: this.store.listToolCalls(runId),
        to,
        toModelId: input.toModelId,
        repositoryRevision: this.repositoryRevision,
      });
      if (!plan.ok) return { ok: false, reason: plan.reason, detail: plan.detail, run };
      if (input.beforeCommit) await input.beforeCommit();
      const committed = this.store.commitProviderSwitch({
        requestId: input.requestId,
        runId,
        expectedLastEventSequence: run.lastEventSequence,
        runPatch: {
          providerId: plan.run.providerId,
          modelId: plan.run.modelId,
          ...(plan.run.budget ? { budget: plan.run.budget } : {}),
        },
        checkpoint: {
          runId,
          taskFacts: plan.checkpoint.taskFacts,
          pendingCalls: [],
          workspaceRevision: plan.checkpoint.workspaceRevision,
          savedAt: plan.checkpoint.savedAt,
        },
        handoffDigest: plan.portable.handoffDigest,
        eventPayload: { dropped: plan.portable.dropped },
      });
      if (!committed.ok) {
        return { ok: false, reason: committed.reason, detail: committed.detail, run: this.store.getRun(runId) };
      }
      return {
        ok: true,
        idempotent: committed.duplicate,
        run: committed.run,
        portable: plan.portable,
        messages: plan.messages,
      };
    } finally {
      this.store.releaseLease(runId, holder);
    }
  }

  private idempotentSwitch(
    runId: string,
    input: SwitchProviderInput,
    record: { runId: string; to: string },
  ): SwitchProviderResult {
    const to = `${input.toProviderId}/${input.toModelId}`;
    if (record.runId !== runId || record.to !== to) {
      return {
        ok: false,
        reason: "request_id_conflict",
        detail: `Switch request ${input.requestId} was already used for ${record.runId} -> ${record.to}.`,
        run: this.store.getRun(runId),
      };
    }
    return { ok: true, idempotent: true, run: this.store.getRun(runId)! };
  }

  /** Active run id for bridge/UI; set as soon as startRun creates the record. */
  getCurrentRunId(): string | null {
    return this.currentRunId;
  }

  requestPause(): void {
    this.pauseRequested = true;
  }

  requestCancel(): void {
    this.cancelRequested = true;
    this.abort.abort();
  }

  async startRun(input: StartRunInput): Promise<RunResult> {
    const limits = RunLimitsSchema.parse(input.limits ?? {});
    const runId = randomUUID();
    this.currentRunId = runId;
    const created = nowIso();
    this.store.createRun({
      id: runId,
      taskId: input.task.id,
      providerId: this.provider.id,
      modelId: input.modelId ?? "fake-v1",
      state: "queued",
      limits,
      createdAt: created,
      updatedAt: created,
      toolStepsUsed: 0,
      lastEventSequence: 0,
      budget:
        limits.estimatedSpendingLimitUsd !== undefined
          ? freshBudget(
              limits.estimatedSpendingLimitUsd,
              this.prices?.priceVersion,
            )
          : undefined,
    });

    const lease = this.store.acquireLease(runId, this.holderId);
    if (!lease.ok) {
      throw new Error(lease.reason);
    }

    let summary = "";
    try {
      this.store.updateRunState(runId, "running");
      this.store.appendEvent(runId, "run_started", {
        taskId: input.task.id,
        goal: input.task.goal,
        mode: input.task.mode,
      });

      const messages: ProviderMessage[] = [
        {
          role: "system",
          content:
            "You are the KUR3 harness offline agent. Use tools to complete the task. Stay inside the workspace.",
        },
        {
          role: "user",
          content: `Goal: ${input.task.goal}\nMode: ${input.task.mode}\nAcceptance: ${JSON.stringify(input.task.acceptanceCriteria)}`,
        },
      ];
      summary = await this.drive(runId, input.task, messages, 0);
    } finally {
      this.store.releaseLease(runId, this.holderId);
    }

    const verifications = this.verify(input.task);
    for (const v of verifications) {
      this.store.appendEvent(runId, "verification_recorded", { ...v });
    }
    this.sealCheckpoint(runId, input.task);

    const finalRun = this.store.getRun(runId)!;
    return { run: finalRun, verifications, summary: summary.trim() };
  }

  /**
   * Acquire the run lease, reconcile non-terminal tool calls, then continue
   * only when that is safe. Refuses to run while another holder owns the lease.
   * Does not start new billable work in budget_exhausted unless an explicit
   * limit raise was recorded after exhaustion.
   */
  async resumeRun(runId: string, task?: Task): Promise<ResumeResult> {
    const lease = this.store.acquireLease(runId, this.holderId);
    if (!lease.ok) {
      return {
        ok: false,
        reason: lease.reason,
        actions: [],
        continued: false,
      };
    }

    try {
      let run = this.store.getRun(runId);
      if (!run) {
        return {
          ok: false,
          reason: `Unknown run: ${runId}`,
          actions: [],
          continued: false,
        };
      }
      this.currentRunId = runId;
      // An explicit resume supersedes an earlier pause request.
      this.pauseRequested = false;
      const resumable =
        run.state === "running" ||
        run.state === "paused" ||
        run.state === "budget_exhausted";
      if (!resumable) {
        return {
          ok: false,
          reason: `Cannot resume from state ${run.state}`,
          run,
          actions: [],
          continued: false,
        };
      }

      if (run.state === "running") {
        this.store.appendEvent(runId, "run_interrupted", {
          reason: "stale running run reconciled before resume",
        });
      }

      if (run.budget && run.budget.reservedUsd > 0) {
        const settled = settleDanglingReservation(run.budget);
        this.store.patchRun(runId, { budget: settled });
        this.store.appendEvent(runId, "budget_reconciled", {
          costLabel: "unknown",
          note: ESTIMATED_SPENDING_LIMIT_NOTE,
          danglingReservation: true,
        });
      }

      const actions = await this.reconcilePending(runId);
      run = this.store.getRun(runId)!;

      if (run.state === "running") {
        this.store.updateRunState(runId, "paused");
        this.checkpoint(runId, task ?? this.taskFromCheckpoint(runId), []);
        run = this.store.getRun(runId)!;
      }

      const unsafe = actions.some(
        (a) =>
          a.action === "conflict_skip_write" || a.action === "unsafe_no_retry",
      );
      const transcript = this.readTranscript(runId);
      const resumeTask = task ?? this.taskFromCheckpoint(runId);
      const allowBillable = explicitBudgetRaiseAllowsWork(
        run.state,
        run.budget,
      );

      if (!allowBillable) {
        return {
          ok: true,
          reason:
            "budget_exhausted: no new billable work without an explicit estimated spending limit update",
          run,
          actions,
          continued: false,
        };
      }

      if (unsafe || !transcript || !resumeTask) {
        return {
          ok: true,
          reason: unsafe
            ? "unresolved recovery; model loop not continued"
            : "reconciled; model loop not continued without a safe transcript",
          run,
          actions,
          continued: false,
        };
      }

      if (run.state === "paused" || run.state === "budget_exhausted") {
        this.store.updateRunState(runId, "running");
      }
      const summary = await this.drive(
        runId,
        resumeTask,
        transcript,
        this.store.getRun(runId)?.toolStepsUsed ?? 0,
      );
      const verifications = this.verify(resumeTask);
      for (const v of verifications) {
        this.store.appendEvent(runId, "verification_recorded", { ...v });
      }
      this.sealCheckpoint(runId, resumeTask);
      return {
        ok: true,
        run: this.store.getRun(runId),
        actions,
        continued: true,
        summary,
        verifications,
      };
    } finally {
      this.store.releaseLease(runId, this.holderId);
    }
  }

  /**
   * Explicit budget update. Does not itself send a provider request.
   * Continuation from budget_exhausted requires this AND resumeRun.
   */
  raiseEstimatedSpendingLimit(runId: string, estimatedLimitUsd: number): Run {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (!Number.isFinite(estimatedLimitUsd) || estimatedLimitUsd < 0) {
      throw new Error("estimated spending limit must be a non-negative number");
    }
    const budget: BudgetSnapshot = {
      ...(run.budget ??
        freshBudget(estimatedLimitUsd, this.prices?.priceVersion)),
      estimatedLimitUsd,
      limitRaisedAt: nowIso(),
      priceVersion: run.budget?.priceVersion ?? this.prices?.priceVersion,
    };
    this.store.patchRun(runId, {
      limits: { ...run.limits, estimatedSpendingLimitUsd: estimatedLimitUsd },
      budget,
    });
    this.store.appendEvent(runId, "budget_limit_raised", {
      estimatedLimitUsd,
      note: ESTIMATED_SPENDING_LIMIT_NOTE,
    });
    return this.store.getRun(runId)!;
  }

  exportHandoff(runId: string): Handoff {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    const pending = this.store
      .listToolCalls(runId)
      .filter((c) =>
        c.lifecycle === "prepared" ||
        c.lifecycle === "running" ||
        c.lifecycle === "outcome_unknown",
      )
      .map((c) => c.id);
    return buildHandoff({
      run,
      events: this.store.listEvents(runId),
      checkpoint: this.store.getCheckpoint(runId),
      pendingCallIds: pending,
      repositoryRevision: this.repositoryRevision,
    });
  }

  private async drive(
    runId: string,
    task: Task,
    messages: ProviderMessage[],
    stepsStart: number,
  ): Promise<string> {
    let summary = "";
    let steps = stepsStart;
    let identicalFailures = 0;
    let lastFailureKey = "";
    const startedAt = this.readStartedAt(runId);

    while (true) {
      const run = this.store.getRun(runId);
      if (!run) break;
      const limits = run.limits;
      if (steps >= limits.maxToolSteps) {
        if (run.state === "running") {
          this.store.updateRunState(runId, "failed");
          this.store.appendEvent(runId, "error", {
            code: "max_tool_steps",
            message: `Exceeded maxToolSteps (${limits.maxToolSteps})`,
          });
        }
        break;
      }

      if (this.cancelRequested) {
        this.store.updateRunState(runId, "canceled");
        this.store.appendEvent(runId, "run_state_changed", { state: "canceled" });
        break;
      }
      if (this.pauseRequested) {
        this.store.updateRunState(runId, "paused");
        this.store.appendEvent(runId, "run_state_changed", { state: "paused" });
        // Checkpoint last so it covers the pause event and the paused state.
        this.checkpoint(runId, task, [], messages);
        break;
      }
      if (Date.now() - startedAt > limits.maxDurationMs) {
        this.store.updateRunState(runId, "failed");
        this.store.appendEvent(runId, "error", {
          code: "timeout",
          message: "Run exceeded maxDurationMs",
        });
        break;
      }

      const provider = this.providerFor(run);
      if (!provider) {
        this.store.updateRunState(runId, "failed");
        this.store.appendEvent(runId, "error", {
          code: "provider_unavailable",
          message: `No registered provider for ${run.providerId}`,
        });
        this.store.appendEvent(runId, "run_state_changed", { state: "failed" });
        this.checkpoint(runId, task, [], messages);
        break;
      }

      this.checkpoint(runId, task, [], messages);
      const gate = this.beginRequestBudget(runId, messages);
      if (!gate.proceed) break;

      const toolReqs: Array<{
        callId: string;
        name: string;
        input: Record<string, unknown>;
      }> = [];
      let lastUsage: { inputTokens?: number; outputTokens?: number } | undefined;
      let assistantText = "";
      /** First error in this turn. Any error invalidates the whole turn. */
      let turnError: { code: string; message: string } | undefined;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        if (gate.reservationUsd === undefined && run.limits.estimatedSpendingLimitUsd === undefined) {
          return;
        }
        this.finishRequestBudget(runId, gate.reservationUsd, lastUsage);
      };

      try {
        for await (const ev of provider.stream(
          {
            modelId: run.modelId,
            messages,
            tools: [...this.tools.values()].map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
          this.abort.signal,
        )) {
          if (ev.type === "text_delta") {
            summary += ev.text;
            assistantText += ev.text;
            this.store.appendEvent(runId, "model_text_delta", { text: ev.text });
          } else if (ev.type === "tool_request") {
            if (!ev.name || typeof ev.input !== "object" || ev.input === null) {
              this.store.appendEvent(runId, "error", {
                code: "malformed_tool",
                message: "Incomplete tool request; turn invalidated",
              });
              turnError ??= { code: "malformed_tool", message: "Incomplete tool request" };
              continue;
            }
            toolReqs.push({
              callId: ev.callId,
              name: ev.name,
              input: ev.input as Record<string, unknown>,
            });
          } else if (ev.type === "usage") {
            lastUsage = {
              inputTokens: ev.inputTokens,
              outputTokens: ev.outputTokens,
            };
            const priced = priceReportedUsage(this.prices, lastUsage);
            this.store.appendEvent(runId, "usage", {
              inputTokens: ev.inputTokens,
              outputTokens: ev.outputTokens,
              costLabel: priced.costLabel,
              ...(priced.estimatedCostUsd !== undefined
                ? { estimatedCostUsd: priced.estimatedCostUsd }
                : {}),
              note: ESTIMATED_SPENDING_LIMIT_NOTE,
            });
          } else if (ev.type === "error") {
            this.store.appendEvent(runId, "error", {
              code: ev.code,
              message: ev.message,
            });
            turnError ??= { code: ev.code, message: ev.message };
          } else if (ev.type === "completed") {
            this.store.appendEvent(runId, "model_completed", {
              finishReason: ev.finishReason,
            });
          }
        }
      } finally {
        settle();
      }

      if (this.store.getRun(runId)?.state === "budget_exhausted") break;

      if (this.cancelRequested || this.abort.signal.aborted) {
        const current = this.store.getRun(runId);
        if (current?.state === "running") {
          this.store.updateRunState(runId, "canceled");
          this.store.appendEvent(runId, "run_state_changed", { state: "canceled" });
        }
        this.checkpoint(runId, task, [], messages);
        break;
      }

      // P1-5: a provider error (or a contract-violating tool request) ends the
      // run as failed — never completed — and no tool from the turn runs.
      if (turnError) {
        const current = this.store.getRun(runId);
        if (current?.state === "running") {
          this.store.updateRunState(runId, "failed");
          this.store.appendEvent(runId, "run_state_changed", {
            state: "failed",
            reason: turnError.code,
            droppedToolRequests: toolReqs.length,
          });
        }
        this.checkpoint(runId, task, [], messages);
        break;
      }

      if (toolReqs.length === 0) {
        if (this.cancelRequested || this.abort.signal.aborted) {
          const current = this.store.getRun(runId);
          if (current?.state === "running") {
            this.store.updateRunState(runId, "canceled");
            this.store.appendEvent(runId, "run_state_changed", {
              state: "canceled",
            });
          }
          this.checkpoint(runId, task, [], messages);
          break;
        }
        const current = this.store.getRun(runId);
        if (current?.state === "running") {
          this.store.updateRunState(runId, "completed");
          this.store.appendEvent(runId, "run_state_changed", {
            state: "completed",
          });
        }
        this.checkpoint(runId, task, [], messages);
        break;
      }

      const req = toolReqs[0]!;
      steps += 1;
      this.store.patchRun(runId, { toolStepsUsed: steps });

      const policy = evaluateToolPolicy(req.name, req.input, {
        mode: task.mode,
        knownTools: this.tools,
        commandWorkerEnabled: this.commandWorker.isolationKind !== "disabled",
      });
      const inputDigest = digestInput(req.input);
      const meta = this.toolMeta(req.name);

      this.store.appendEvent(runId, "tool_prepared", {
        callId: req.callId,
        name: req.name,
        inputDigest,
        decision: policy.decision,
      });

      if (policy.decision === "deny") {
        this.store.appendEvent(runId, "tool_denied", {
          callId: req.callId,
          reason: policy.reason,
        });
        this.store.upsertToolCall({
          id: req.callId,
          runId,
          name: req.name,
          input: req.input,
          inputDigest,
          policyDecision: "deny",
          lifecycle: "denied",
          effect: meta.effect,
          safeRetry: meta.safeRetry,
          mutates: meta.mutates,
          error: policy.reason,
        });
        const failKey = `deny:${req.name}`;
        identicalFailures = failKey === lastFailureKey ? identicalFailures + 1 : 1;
        lastFailureKey = failKey;
        messages.push({
          role: "assistant",
          content: assistantText,
          toolCalls: [{ id: req.callId, name: req.name, input: req.input }],
        });
        messages.push({
          role: "tool",
          name: req.name,
          toolCallId: req.callId,
          content: JSON.stringify({ status: "denied", reason: policy.reason }),
        });
        if (identicalFailures >= limits.maxIdenticalFailures) {
          this.store.updateRunState(runId, "failed");
          this.store.appendEvent(runId, "error", {
            code: "identical_failures",
            message: `Stopped after ${identicalFailures} identical denials of ${req.name}`,
          });
          break;
        }
        continue;
      }

      if (policy.decision === "require_approval") {
        this.store.updateRunState(runId, "waiting_for_approval");
        this.checkpoint(runId, task, [req.callId], messages);
        break;
      }

      let expectedPreHash: string | undefined;
      let expectedPostHash: string | undefined;
      if (
        req.name === "apply_patch" &&
        typeof req.input.newContent === "string" &&
        typeof req.input.expectedHash === "string"
      ) {
        expectedPreHash = req.input.expectedHash;
        expectedPostHash = contentHash(req.input.newContent);
      }

      const prepared: ToolCall = {
        id: req.callId,
        runId,
        name: req.name,
        input: req.input,
        inputDigest,
        policyDecision: "allow",
        lifecycle: "running",
        effect: meta.effect,
        safeRetry: meta.safeRetry,
        mutates: meta.mutates,
        expectedPreHash,
        expectedPostHash,
      };
      // Persist the running call BEFORE the mutation so a crash can reconcile.
      this.store.upsertToolCall(prepared);
      this.checkpoint(runId, task, [req.callId], messages);
      this.store.appendEvent(runId, "tool_started", {
        callId: req.callId,
        name: req.name,
        expectedPreHash,
        expectedPostHash,
      });

      let result: unknown;
      try {
        result = await executeTool(
          {
            fileWorker: this.worker,
            commandWorker: this.commandWorker,
            abortSignal: this.abort.signal,
          },
          req.name,
          req.input,
        );
        const status =
          result && typeof result === "object" && "status" in result
            ? String((result as { status: unknown }).status)
            : "ok";
        const lifecycle =
          status === "conflict" ||
          status === "error" ||
          status === "timed_out" ||
          status === "canceled"
            ? "failed"
            : "succeeded";
        this.store.upsertToolCall({
          ...prepared,
          lifecycle,
          result,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const unknown: ToolCall = {
          ...prepared,
          lifecycle: "outcome_unknown",
          error: message,
        };
        if (req.name === "apply_patch" || (meta.safeRetry && !meta.mutates)) {
          const reconciled = await reconcileToolCall(unknown, {
            inspectHash: (p) => this.inspect(p),
            execute: (name, input) => this.execTool(name, input),
          });
          this.store.upsertToolCall(reconciled.call);
          result = reconciled.call.result ?? {
            status: reconciled.call.lifecycle,
            error: message,
          };
        } else {
          this.store.upsertToolCall({
            ...unknown,
            reconciliation: "unsafe_no_retry",
          });
          result = { status: "outcome_unknown", error: message };
        }
      }

      this.store.appendEvent(runId, "tool_finished", {
        callId: req.callId,
        name: req.name,
        result,
      });

      messages.push({
        role: "assistant",
        content: assistantText,
        toolCalls: [{ id: req.callId, name: req.name, input: req.input }],
      });
      messages.push({
        role: "tool",
        name: req.name,
        toolCallId: req.callId,
        content: JSON.stringify(result),
      });
      this.checkpoint(runId, task, [], messages);
    }

    return summary;
  }

  private beginRequestBudget(
    runId: string,
    messages: ProviderMessage[],
  ): { proceed: boolean; reservationUsd?: number } {
    const run = this.store.getRun(runId);
    if (!run) return { proceed: false };
    const limit = run.limits.estimatedSpendingLimitUsd;
    if (limit === undefined) return { proceed: true };

    const budget =
      run.budget ?? freshBudget(limit, this.prices?.priceVersion);
    const quote = quoteReservation({
      estimatedInputTokens: estimateInputTokens(messages),
      maxOutputTokens: run.limits.maxOutputTokens,
      prices: this.prices,
    });
    const decision = assessReservation({ limitUsd: limit, budget, quote });
    if (!decision.ok) {
      const exhausted: BudgetSnapshot = {
        ...budget,
        estimatedLimitUsd: limit,
        exhaustedAt: nowIso(),
      };
      this.store.patchRun(runId, { budget: exhausted });
      if (run.state === "running") {
        this.store.updateRunState(runId, "budget_exhausted");
      }
      this.store.appendEvent(runId, "error", {
        code: "budget_exhausted",
        message: decision.reason,
        reservationLabel: quote.label,
        note: ESTIMATED_SPENDING_LIMIT_NOTE,
      });
      return { proceed: false };
    }

    if (decision.reservationUsd !== undefined) {
      const reserved = applyReservation(
        { ...budget, estimatedLimitUsd: limit },
        decision.reservationUsd,
      );
      // Durable hold BEFORE the provider request.
      this.store.patchRun(runId, { budget: reserved });
      this.store.appendEvent(runId, "budget_reserved", {
        reservationUsd: decision.reservationUsd,
        reservationLabel: "usd",
        note: ESTIMATED_SPENDING_LIMIT_NOTE,
      });
      return { proceed: true, reservationUsd: decision.reservationUsd };
    }
    return { proceed: true };
  }

  private finishRequestBudget(
    runId: string,
    reservationUsd: number | undefined,
    usage: { inputTokens?: number; outputTokens?: number } | undefined,
  ): void {
    const run = this.store.getRun(runId);
    if (!run) return;
    const limit = run.limits.estimatedSpendingLimitUsd;
    const budget =
      run.budget ??
      (limit !== undefined
        ? freshBudget(limit, this.prices?.priceVersion)
        : undefined);
    if (!budget) return;
    const rec = reconcileReservation({
      budget,
      reservationUsd,
      usage,
      prices: this.prices,
    });
    this.store.patchRun(runId, { budget: rec.budget });
    this.store.appendEvent(runId, "budget_reconciled", {
      costLabel: rec.costLabel,
      ...(rec.estimatedCostUsd !== undefined
        ? { estimatedCostUsd: rec.estimatedCostUsd }
        : {}),
      note: ESTIMATED_SPENDING_LIMIT_NOTE,
    });
  }

  private async reconcilePending(runId: string): Promise<RecoveryStep[]> {
    const steps: RecoveryStep[] = [];
    for (const original of this.store.listToolCalls(runId)) {
      let call = original;
      if (call.lifecycle === "prepared" || call.lifecycle === "running") {
        this.store.appendEvent(runId, "tool_outcome_unknown", {
          callId: call.id,
          name: call.name,
        });
        call = { ...call, lifecycle: "outcome_unknown" };
        this.store.upsertToolCall(call);
      }
      const reconciled = await reconcileToolCall(call, {
        inspectHash: (p) => this.inspect(p),
        execute: (name, input) => this.execTool(name, input),
      });
      if (reconciled.step.action !== "terminal_unchanged") {
        this.store.upsertToolCall(reconciled.call);
        this.store.appendEvent(runId, "tool_finished", {
          callId: call.id,
          name: call.name,
          recovery: reconciled.step.action,
          wrote: reconciled.step.wrote,
          result: reconciled.call.result ?? null,
        });
      }
      steps.push(reconciled.step);
    }
    const pending = this.store
      .listToolCalls(runId)
      .filter((c) => c.lifecycle === "outcome_unknown" || c.lifecycle === "running")
      .map((c) => c.id);
    const task = this.taskFromCheckpoint(runId);
    if (task) this.checkpoint(runId, task, pending);
    return steps;
  }

  private inspect(userPath: string): string | undefined {
    const found = this.worker.inspectHash(userPath);
    return found.status === "ok" ? found.hash : undefined;
  }

  private execTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    return executeTool(
      {
        fileWorker: this.worker,
        commandWorker: this.commandWorker,
        abortSignal: this.abort.signal,
      },
      name,
      input,
    );
  }

  private toolMeta(name: string): {
    effect: "read" | "write" | "external";
    safeRetry: boolean;
    mutates: boolean;
  } {
    const def = this.tools.get(name);
    const effect = def?.effect ?? "external";
    return {
      effect,
      safeRetry: def?.safeRetry ?? false,
      mutates: name === "apply_patch" || effect === "external",
    };
  }

  private readStartedAt(runId: string): number {
    const raw = this.store.getCheckpoint(runId)?.taskFacts?.startedAtMs;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    return Date.now();
  }

  private readTranscript(runId: string): ProviderMessage[] | undefined {
    const raw = this.store.getCheckpoint(runId)?.taskFacts?.transcript;
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    const messages: ProviderMessage[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") return undefined;
      const rec = item as Record<string, unknown>;
      if (
        (rec.role !== "system" &&
          rec.role !== "user" &&
          rec.role !== "assistant" &&
          rec.role !== "tool") ||
        typeof rec.content !== "string"
      ) {
        return undefined;
      }
      const toolCalls = Array.isArray(rec.toolCalls)
        ? rec.toolCalls.filter(
            (c): c is { id: string; name: string; input: Record<string, unknown> } =>
              !!c &&
              typeof c === "object" &&
              typeof (c as { id?: unknown }).id === "string" &&
              typeof (c as { name?: unknown }).name === "string" &&
              !!(c as { input?: unknown }).input &&
              typeof (c as { input?: unknown }).input === "object",
          )
        : undefined;
      messages.push({
        role: rec.role,
        content: rec.content,
        name: typeof rec.name === "string" ? rec.name : undefined,
        toolCallId: typeof rec.toolCallId === "string" ? rec.toolCallId : undefined,
        ...(toolCalls?.length ? { toolCalls } : {}),
      });
    }
    return messages;
  }

  private taskFromCheckpoint(runId: string): Task | undefined {
    const facts = this.store.getCheckpoint(runId)?.taskFacts;
    if (!facts || typeof facts.goal !== "string") return undefined;
    const criteria: AcceptanceCriterion[] = [];
    if (Array.isArray(facts.acceptanceCriteria)) {
      for (const item of facts.acceptanceCriteria) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        if (typeof rec.id !== "string" || typeof rec.description !== "string") continue;
        criteria.push(rec as AcceptanceCriterion);
      }
    }
    return {
      id: typeof facts.taskId === "string" ? facts.taskId : runId,
      projectId: "resumed",
      goal: facts.goal,
      scope: Array.isArray(facts.scope)
        ? facts.scope.filter((s): s is string => typeof s === "string")
        : [],
      mode: facts.mode === "plan" ? "plan" : "run",
      acceptanceCriteria: criteria,
    };
  }

  private checkpoint(
    runId: string,
    task: Task | undefined,
    pendingCalls: string[],
    transcript?: ProviderMessage[],
  ): void {
    const run = this.store.getRun(runId);
    if (!run || !task) return;
    const previous = this.store.getCheckpoint(runId)?.taskFacts ?? {};
    const startedAtMs =
      typeof previous.startedAtMs === "number" ? previous.startedAtMs : Date.now();
    this.store.saveCheckpointWithEvent({
      runId,
      taskFacts: {
        ...previous,
        taskId: task.id,
        goal: task.goal,
        mode: task.mode,
        scope: task.scope,
        acceptanceCriteria: task.acceptanceCriteria,
        startedAtMs,
        transcript: transcript ? copyMessages(transcript) : previous.transcript,
      },
      pendingCalls,
      savedAt: nowIso(),
    });
  }

  /** Re-save the checkpoint after trailing events (e.g. verifications). */
  private sealCheckpoint(runId: string, task: Task): void {
    const pending = this.store.getCheckpoint(runId)?.pendingCalls ?? [];
    this.checkpoint(runId, task, pending);
  }

  private verify(task: Task): Verification[] {
    const out: Verification[] = [];
    for (const c of task.acceptanceCriteria) {
      if (!c.check) {
        out.push({
          criterionId: c.id,
          description: c.description,
          outcome: "not_run",
          evidence: "No check defined",
        });
        continue;
      }
      if (c.check.type === "file_contains" && c.check.path && c.check.substring) {
        const abs = path.join(this.worker.workspaceRoot, c.check.path);
        if (!fs.existsSync(abs)) {
          out.push({
            criterionId: c.id,
            description: c.description,
            outcome: "failed",
            evidence: `Missing file ${c.check.path}`,
          });
          continue;
        }
        const text = fs.readFileSync(abs, "utf8");
        const pass = text.includes(c.check.substring);
        out.push({
          criterionId: c.id,
          description: c.description,
          outcome: pass ? "passed" : "failed",
          evidence: pass
            ? `Found substring in ${c.check.path}`
            : `Substring not found in ${c.check.path}`,
        });
        continue;
      }
      if (c.check.type === "file_exists" && c.check.path) {
        const abs = path.join(this.worker.workspaceRoot, c.check.path);
        const pass = fs.existsSync(abs);
        out.push({
          criterionId: c.id,
          description: c.description,
          outcome: pass ? "passed" : "failed",
          evidence: pass ? "File exists" : "File missing",
        });
        continue;
      }
      out.push({
        criterionId: c.id,
        description: c.description,
        outcome: "blocked",
        evidence: `Unsupported check type: ${c.check.type}`,
      });
    }
    return out;
  }
}
