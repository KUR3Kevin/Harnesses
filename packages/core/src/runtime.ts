import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ModelProvider,
  ProviderMessage,
  Run,
  RunLimits,
  Task,
  Verification,
} from "@kur3/contracts";
import { RunLimitsSchema } from "@kur3/contracts";
import { evaluateToolPolicy } from "@kur3/policy";
import { RunStore } from "@kur3/storage";
import { executeTool, toolRegistry } from "@kur3/tools";
import {
  FileWorker,
  createCommandWorker,
  type CommandWorker,
} from "@kur3/worker";

export interface RuntimeOptions {
  workspaceRoot: string;
  dataDir: string;
  provider: ModelProvider;
  holderId?: string;
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

function digestInput(input: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Single-run orchestration: provider stream → policy → one tool at a time →
 * checkpoint → verification. Custom lightweight adapter (see ADR-0002).
 */
export class HarnessRuntime {
  private readonly store: RunStore;
  private readonly worker: FileWorker;
  private readonly commandWorker: CommandWorker;
  private readonly provider: ModelProvider;
  private readonly holderId: string;
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
    this.holderId = options.holderId ?? randomUUID();
  }

  getStore(): RunStore {
    return this.store;
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
    const run = this.store.createRun({
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
    });

    const lease = this.store.acquireLease(runId, this.holderId);
    if (!lease.ok) {
      throw new Error(lease.reason);
    }

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

    let summary = "";
    let steps = 0;
    let identicalFailures = 0;
    let lastFailureKey = "";
    const startedAt = Date.now();

    try {
      while (steps < limits.maxToolSteps) {
        if (this.cancelRequested) {
          this.store.updateRunState(runId, "canceled");
          this.store.appendEvent(runId, "run_state_changed", {
            state: "canceled",
          });
          break;
        }
        if (this.pauseRequested) {
          this.checkpoint(runId, input.task);
          this.store.updateRunState(runId, "paused");
          this.store.appendEvent(runId, "run_state_changed", {
            state: "paused",
          });
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

        const caps = this.provider.capabilities();
        if (!caps.nativeTools && input.task.mode === "run") {
          // Still allow text-only completion
        }

        const toolReqs: Array<{
          callId: string;
          name: string;
          input: Record<string, unknown>;
        }> = [];

        for await (const ev of this.provider.stream(
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
            this.store.appendEvent(runId, "model_text_delta", { text: ev.text });
          } else if (ev.type === "tool_request") {
            // Only complete validated tool requests are accepted (guide §7)
            if (!ev.name || typeof ev.input !== "object" || ev.input === null) {
              this.store.appendEvent(runId, "error", {
                code: "malformed_tool",
                message: "Incomplete tool request ignored",
              });
              continue;
            }
            toolReqs.push({
              callId: ev.callId,
              name: ev.name,
              input: ev.input as Record<string, unknown>,
            });
          } else if (ev.type === "usage") {
            this.store.appendEvent(runId, "usage", { ...ev });
          } else if (ev.type === "error") {
            this.store.appendEvent(runId, "error", {
              code: ev.code,
              message: ev.message,
            });
          } else if (ev.type === "completed") {
            this.store.appendEvent(runId, "model_completed", {
              finishReason: ev.finishReason,
            });
          }
        }

        if (toolReqs.length === 0) {
          if (this.cancelRequested || this.abort.signal.aborted) {
            this.store.updateRunState(runId, "canceled");
            this.store.appendEvent(runId, "run_state_changed", {
              state: "canceled",
            });
            this.checkpoint(runId, input.task);
            break;
          }
          this.store.updateRunState(runId, "completed");
          this.store.appendEvent(runId, "run_state_changed", {
            state: "completed",
          });
          this.checkpoint(runId, input.task);
          break;
        }

        // Execute one tool at a time (guide §8)
        const req = toolReqs[0]!;
        steps += 1;
        this.store.patchRun(runId, { toolStepsUsed: steps });

        const policy = evaluateToolPolicy(req.name, req.input, {
          mode: input.task.mode,
          knownTools: this.tools,
          commandWorkerEnabled:
            this.commandWorker.isolationKind !== "disabled",
        });
        const inputDigest = digestInput(req.input);

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
          const failKey = `deny:${req.name}`;
          identicalFailures =
            failKey === lastFailureKey ? identicalFailures + 1 : 1;
          lastFailureKey = failKey;
          messages.push({
            role: "assistant",
            content: `Requested tool ${req.name}`,
          });
          messages.push({
            role: "tool",
            name: req.name,
            toolCallId: req.callId,
            content: JSON.stringify({
              status: "denied",
              reason: policy.reason,
            }),
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
          this.checkpoint(runId, input.task);
          break;
        }

        this.store.appendEvent(runId, "tool_started", {
          callId: req.callId,
          name: req.name,
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
        } catch (err) {
          result = {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          };
        }

        this.store.appendEvent(runId, "tool_finished", {
          callId: req.callId,
          name: req.name,
          result,
        });

        messages.push({
          role: "assistant",
          content: `Tool call ${req.name}`,
        });
        messages.push({
          role: "tool",
          name: req.name,
          toolCallId: req.callId,
          content: JSON.stringify(result),
        });

        this.checkpoint(runId, input.task);
      }

      if (steps >= limits.maxToolSteps) {
        const current = this.store.getRun(runId);
        if (current && current.state === "running") {
          this.store.updateRunState(runId, "failed");
          this.store.appendEvent(runId, "error", {
            code: "max_tool_steps",
            message: `Exceeded maxToolSteps (${limits.maxToolSteps})`,
          });
        }
      }
    } finally {
      this.store.releaseLease(runId, this.holderId);
    }

    const verifications = this.verify(input.task);
    for (const v of verifications) {
      this.store.appendEvent(runId, "verification_recorded", { ...v });
    }

    const finalRun = this.store.getRun(runId)!;
    return { run: finalRun, verifications, summary: summary.trim() };
  }

  private checkpoint(runId: string, task: Task): void {
    const run = this.store.getRun(runId);
    if (!run) return;
    this.store.saveCheckpoint({
      runId,
      runState: run.state,
      lastEventSequence: run.lastEventSequence,
      taskFacts: {
        goal: task.goal,
        mode: task.mode,
        acceptanceCriteria: task.acceptanceCriteria,
      },
      pendingCalls: [],
      savedAt: nowIso(),
    });
    this.store.appendEvent(runId, "checkpoint_saved", {
      sequence: run.lastEventSequence,
    });
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
