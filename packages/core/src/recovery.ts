import type { ToolCall, ToolCallLifecycle } from "@kur3/contracts";

export type RecoveryAction =
  | "already_applied_skip_write"
  | "retry_write_once"
  | "conflict_skip_write"
  | "retry_safe_readonly"
  | "unsafe_no_retry"
  | "terminal_unchanged";

const PENDING = new Set<ToolCallLifecycle>([
  "prepared",
  "running",
  "outcome_unknown",
]);

/**
 * Decide how to treat an interrupted tool call AFTER inspecting the workspace.
 * External mutations are never auto-retried. File writes retry only when the
 * bytes still match the expected pre-hash; a post-hash match skips the write.
 */
export function planRecoveryAction(
  call: ToolCall,
  observedHash: string | undefined,
): RecoveryAction {
  if (!PENDING.has(call.lifecycle)) return "terminal_unchanged";

  const external = call.effect === "external" || call.name === "run_command";
  if (call.mutates === true && external) return "unsafe_no_retry";

  if (call.mutates !== true) {
    if (call.safeRetry === true && (call.effect === "read" || call.name === "propose_patch")) {
      return "retry_safe_readonly";
    }
    return "unsafe_no_retry";
  }

  if (call.name !== "apply_patch") return "unsafe_no_retry";
  if (!call.expectedPreHash || !call.expectedPostHash || observedHash === undefined) {
    return "unsafe_no_retry";
  }
  if (observedHash === call.expectedPostHash) return "already_applied_skip_write";
  if (observedHash === call.expectedPreHash) return "retry_write_once";
  return "conflict_skip_write";
}

export interface RecoveryStep {
  callId: string;
  action: RecoveryAction;
  wrote: boolean;
  lifecycle: ToolCallLifecycle;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return undefined;
}

/**
 * Apply a recovery plan. `execute` is invoked at most once, and only for
 * retry_write_once (after a second hash check) or a declared-safe read.
 */
export async function reconcileToolCall(
  call: ToolCall,
  deps: {
    inspectHash: (userPath: string) => string | undefined;
    execute: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  },
): Promise<{ call: ToolCall; step: RecoveryStep }> {
  const userPath = typeof call.input.path === "string" ? call.input.path : undefined;
  const observed =
    call.name === "apply_patch" && userPath
      ? deps.inspectHash(userPath)
      : undefined;

  let action = planRecoveryAction(call, observed);

  if (action === "retry_write_once" && userPath) {
    const again = deps.inspectHash(userPath);
    if (again === call.expectedPostHash) {
      action = "already_applied_skip_write";
    } else if (again !== call.expectedPreHash) {
      action = "conflict_skip_write";
    }
  }

  const finish = (
    next: ToolCall,
    wrote: boolean,
    chosen: RecoveryAction = action,
  ) => {
    const stored: ToolCall = { ...next, reconciliation: chosen };
    return {
      call: stored,
      step: {
        callId: stored.id,
        action: chosen,
        wrote,
        lifecycle: stored.lifecycle,
      },
    };
  };

  if (action === "terminal_unchanged") {
    return finish(call, false);
  }

  if (action === "already_applied_skip_write") {
    return finish(
      {
        ...call,
        lifecycle: "succeeded",
        result: {
          status: "applied",
          reconciled: true,
          path: userPath,
          previousHash: call.expectedPreHash,
          newHash: call.expectedPostHash,
          note: "content already matched expected post-hash; write not repeated",
        },
      },
      false,
    );
  }

  if (action === "conflict_skip_write") {
    return finish(
      {
        ...call,
        lifecycle: "failed",
        error:
          "conflict: file hash matches neither expected pre-hash nor post-hash; not overwritten",
        result: {
          status: "conflict",
          actualHash: observed,
          expectedPreHash: call.expectedPreHash,
          expectedPostHash: call.expectedPostHash,
        },
      },
      false,
    );
  }

  if (action === "unsafe_no_retry") {
    return finish(
      {
        ...call,
        lifecycle: "outcome_unknown",
        error:
          "outcome unknown; not retried (external mutation, undeclared retry, or missing hashes)",
      },
      false,
    );
  }

  let result: unknown;
  try {
    result = await deps.execute(call.name, call.input);
  } catch (err) {
    const after = userPath ? deps.inspectHash(userPath) : undefined;
    const message = err instanceof Error ? err.message : String(err);
    if (action === "retry_write_once" && after && after === call.expectedPostHash) {
      return finish(
        {
          ...call,
          lifecycle: "succeeded",
          result: {
            status: "applied",
            reconciled: true,
            note: "post-hash matched after executor error; no further write",
          },
        },
        false,
        "already_applied_skip_write",
      );
    }
    if (action === "retry_write_once" && after === call.expectedPreHash) {
      return finish(
        { ...call, lifecycle: "failed", error: message, result: { status: "error", error: message } },
        false,
      );
    }
    return finish(
      {
        ...call,
        lifecycle: "outcome_unknown",
        error: message,
      },
      false,
      "unsafe_no_retry",
    );
  }

  const status = asRecord(result)?.status;
  if (action === "retry_write_once") {
    const after = userPath ? deps.inspectHash(userPath) : undefined;
    if (status === "applied") {
      return finish({ ...call, lifecycle: "succeeded", result }, true);
    }
    if (after && after === call.expectedPostHash) {
      return finish(
        { ...call, lifecycle: "succeeded", result },
        false,
        "already_applied_skip_write",
      );
    }
    return finish({ ...call, lifecycle: "failed", result }, false);
  }

  return finish({ ...call, lifecycle: "succeeded", result }, false);
}
