import type {
  BridgeRequest,
  BridgeResponse,
  ModelProvider,
  StartRunParams,
} from "@kur3/contracts";
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeRequestSchema,
  StartRunParamsSchema,
} from "@kur3/contracts";
import { HarnessRuntime } from "./runtime.js";
import type { RunResult } from "./runtime.js";

export interface HarnessBridgeOptions {
  /** Injected provider — FakeProvider for offline; any ModelProvider later. */
  provider: ModelProvider;
  holderId?: string;
}

type BridgeErrorCode = NonNullable<BridgeResponse["error"]>["code"];

/**
 * In-process bridge implementing guide §7 commands against HarnessRuntime.
 *
 * Reconnect safety: subscribe_events / get_run never start a run.
 * Only an explicit start_run creates work. A second start_run while one is
 * in flight returns run_already_active with the existing run id.
 *
 * Process IPC can wrap the same request/response shapes later; this class
 * stays the single orchestration entry for the editor path (see ADR-0006).
 */
export class InProcessHarnessBridge {
  private readonly provider: ModelProvider;
  private readonly holderId: string;
  private runtime: HarnessRuntime | null = null;
  private activeRunId: string | null = null;
  private runPromise: Promise<RunResult> | null = null;
  private lastResult: RunResult | null = null;

  constructor(options: HarnessBridgeOptions) {
    this.provider = options.provider;
    this.holderId = options.holderId ?? "editor-bridge";
  }

  getActiveRunId(): string | null {
    return this.activeRunId;
  }

  async handle(raw: unknown): Promise<BridgeResponse> {
    const parsed = BridgeRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const requestId = readRequestId(raw);
      return this.fail(requestId, "invalid_request", parsed.error.message);
    }
    const req = parsed.data;
    if (req.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
      return this.fail(
        req.requestId,
        "protocol_mismatch",
        `Expected ${BRIDGE_PROTOCOL_VERSION}, got ${req.protocolVersion}`,
      );
    }

    switch (req.command) {
      case "start_run":
        return this.startRun(req.requestId, req.params);
      case "cancel_run":
        return this.cancelRun(req.requestId, req.params.runId);
      case "pause_run":
        return this.pauseRun(req.requestId, req.params.runId);
      case "get_run":
        return this.getRun(req.requestId, req.params.runId);
      case "subscribe_events":
        return this.subscribeEvents(
          req.requestId,
          req.params.runId,
          req.params.afterSequence,
        );
      default: {
        const _exhaustive: never = req;
        void _exhaustive;
        return this.fail("unknown", "invalid_request", "Unhandled command");
      }
    }
  }

  private ok(
    requestId: string,
    extra: Partial<BridgeResponse> = {},
  ): BridgeResponse {
    return {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId,
      ok: true,
      activeRunId: this.activeRunId ?? undefined,
      ...extra,
    };
  }

  private fail(
    requestId: string,
    code: BridgeErrorCode,
    message: string,
    extra: Partial<BridgeResponse> = {},
  ): BridgeResponse {
    return {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: { code, message },
      activeRunId: this.activeRunId ?? undefined,
      ...extra,
    };
  }

  private async startRun(
    requestId: string,
    params: StartRunParams,
  ): Promise<BridgeResponse> {
    const validated = StartRunParamsSchema.parse(params);

    if (this.runPromise && this.activeRunId) {
      const existing = this.runtime?.getStore().getRun(this.activeRunId);
      return this.fail(
        requestId,
        "run_already_active",
        `Run ${this.activeRunId} is still active; cancel it or wait`,
        { run: existing },
      );
    }

    this.runtime = new HarnessRuntime({
      workspaceRoot: validated.workspaceRoot,
      dataDir: validated.dataDir,
      provider: this.provider,
      holderId: this.holderId,
    });
    this.lastResult = null;

    const runtime = this.runtime;
    this.runPromise = runtime.startRun({
      task: validated.task,
      modelId: validated.modelId,
      limits: validated.limits,
    });

    // Async functions run synchronously until the first await. startRun
    // creates the run record before awaiting the provider stream.
    await Promise.resolve();
    const runId = runtime.getCurrentRunId();
    if (!runId) {
      try {
        const result = await this.runPromise;
        this.lastResult = result;
        this.activeRunId = result.run.id;
        this.runPromise = null;
        return this.ok(requestId, {
          run: result.run,
          summary: result.summary,
        });
      } catch (err) {
        this.runPromise = null;
        this.activeRunId = null;
        return this.fail(
          requestId,
          "internal",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    this.activeRunId = runId;
    const run = runtime.getStore().getRun(runId);

    void this.runPromise
      .then((result) => {
        this.lastResult = result;
        this.activeRunId = result.run.id;
      })
      .catch(() => {
        /* surfaced via get_run / subscribe */
      })
      .finally(() => {
        this.runPromise = null;
      });

    return this.ok(requestId, { run });
  }

  private async cancelRun(
    requestId: string,
    runId: string,
  ): Promise<BridgeResponse> {
    if (!this.runtime?.getStore().getRun(runId)) {
      return this.fail(requestId, "run_not_found", `Unknown run ${runId}`);
    }
    this.runtime.requestCancel();
    if (this.runPromise) {
      try {
        this.lastResult = await this.runPromise;
      } catch {
        /* ignore */
      }
      this.runPromise = null;
    }
    const run = this.runtime.getStore().getRun(runId);
    return this.ok(requestId, { run });
  }

  private async pauseRun(
    requestId: string,
    runId: string,
  ): Promise<BridgeResponse> {
    if (!this.runtime?.getStore().getRun(runId)) {
      return this.fail(requestId, "run_not_found", `Unknown run ${runId}`);
    }
    this.runtime.requestPause();
    if (this.runPromise) {
      try {
        this.lastResult = await this.runPromise;
      } catch {
        /* ignore */
      }
      this.runPromise = null;
    }
    const run = this.runtime.getStore().getRun(runId);
    return this.ok(requestId, { run });
  }

  private async getRun(
    requestId: string,
    runId: string,
  ): Promise<BridgeResponse> {
    if (this.runPromise && this.activeRunId === runId) {
      try {
        this.lastResult = await this.runPromise;
      } catch {
        /* ignore */
      }
      this.runPromise = null;
    }
    const run = this.runtime?.getStore().getRun(runId);
    if (!run) {
      return this.fail(requestId, "run_not_found", `Unknown run ${runId}`);
    }
    return this.ok(requestId, {
      run,
      summary:
        this.lastResult?.run.id === runId ? this.lastResult.summary : undefined,
    });
  }

  private async subscribeEvents(
    requestId: string,
    runId: string,
    afterSequence: number,
  ): Promise<BridgeResponse> {
    // Never starts a run — reconnect clients only read durable events.
    if (this.runPromise && this.activeRunId === runId) {
      try {
        this.lastResult = await this.runPromise;
      } catch {
        /* ignore */
      }
      this.runPromise = null;
    }
    const store = this.runtime?.getStore();
    if (!store?.getRun(runId)) {
      return this.fail(requestId, "run_not_found", `Unknown run ${runId}`);
    }
    const events = store.listEvents(runId, afterSequence);
    const run = store.getRun(runId);
    return this.ok(requestId, {
      run,
      events,
      summary:
        this.lastResult?.run.id === runId ? this.lastResult.summary : undefined,
    });
  }
}

function readRequestId(raw: unknown): string {
  if (
    typeof raw === "object" &&
    raw !== null &&
    "requestId" in raw &&
    typeof (raw as { requestId: unknown }).requestId === "string"
  ) {
    return (raw as { requestId: string }).requestId;
  }
  return "unknown";
}

export type { BridgeRequest, BridgeResponse };
