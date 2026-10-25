import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  CheckpointSchema,
  EventSchema,
  RunSchema,
  ToolCallSchema,
  type Checkpoint,
  type Event,
  type EventType,
  type Run,
  type RunState,
  type ToolCall,
  canTransition,
} from "@kur3/contracts";

interface StoreData {
  version: 1;
  runs: Record<string, Run>;
  events: Event[];
  checkpoints: Record<string, Checkpoint>;
  leases: Record<string, { holderId: string; expiresAt: string }>;
  /** Keyed by `${runId}:${callId}`. */
  toolCalls: Record<string, ToolCall>;
  /** Committed provider switches keyed by switch request id (idempotency). */
  providerSwitches: Record<string, ProviderSwitchRecord>;
}

/** Durable record of one committed provider switch (W10 P1-4). */
export interface ProviderSwitchRecord {
  requestId: string;
  runId: string;
  from: string;
  to: string;
  atEventSequence: number;
  handoffDigest: string;
  committedAt: string;
}

export type CommitSwitchResult =
  | { ok: true; duplicate: false; run: Run; checkpoint: Checkpoint; record: ProviderSwitchRecord }
  | { ok: true; duplicate: true; run: Run; record: ProviderSwitchRecord }
  | { ok: false; reason: "unknown_run" | "stale_run" | "request_id_conflict"; detail: string };

function emptyData(): StoreData {
  return {
    version: 1,
    runs: {},
    events: [],
    checkpoints: {},
    leases: {},
    toolCalls: {},
    providerSwitches: {},
  };
}

/**
 * File-backed durable store for runs, ordered events, checkpoints, and leases.
 * Provisional alternative to SQLite (see ADR-0003). Persists outside the
 * project workspace so agent tools cannot silently rewrite harness state
 * when the dataDir is placed under ~/.kur3 or a sibling .kur3-data folder.
 */
export class RunStore {
  private readonly dataPath: string;
  private data: StoreData;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.dataPath = path.join(dataDir, "store.json");
    this.data = this.load();
  }

  private load(): StoreData {
    if (!fs.existsSync(this.dataPath)) return emptyData();
    const raw = JSON.parse(fs.readFileSync(this.dataPath, "utf8")) as Partial<StoreData>;
    return {
      version: 1,
      runs: raw.runs ?? {},
      events: raw.events ?? [],
      checkpoints: raw.checkpoints ?? {},
      leases: raw.leases ?? {},
      toolCalls: raw.toolCalls ?? {},
      providerSwitches: raw.providerSwitches ?? {},
    };
  }

  /** Reload durable state so a lease taken by another process is visible. */
  reload(): void {
    this.data = this.load();
  }

  /**
   * Atomic write: full snapshot to a temp file, fsync, then rename over the
   * store. A crash leaves either the old or the new file, never a mix.
   */
  private persist(data: StoreData = this.data): void {
    const tmp = `${this.dataPath}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2), "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.dataPath);
  }

  /**
   * Apply `mutate` to a copy and persist it in ONE atomic write. In-memory
   * state only changes after the write succeeds, so a failed write leaves
   * memory and disk both at the previous state.
   */
  private transact<T>(mutate: (draft: StoreData) => T): T {
    const draft = structuredClone(this.data);
    const out = mutate(draft);
    this.persist(draft);
    this.data = draft;
    return out;
  }

  createRun(run: Run): Run {
    const parsed = RunSchema.parse(run);
    if (this.data.runs[parsed.id]) {
      throw new Error(`Run already exists: ${parsed.id}`);
    }
    this.data.runs[parsed.id] = parsed;
    this.persist();
    return parsed;
  }

  getRun(runId: string): Run | undefined {
    return this.data.runs[runId];
  }

  updateRunState(runId: string, next: RunState): Run {
    const run = this.data.runs[runId];
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (run.state !== next && !canTransition(run.state, next)) {
      throw new Error(`Illegal transition ${run.state} -> ${next}`);
    }
    const updated: Run = {
      ...run,
      state: next,
      updatedAt: new Date().toISOString(),
    };
    this.data.runs[runId] = RunSchema.parse(updated);
    this.persist();
    return this.data.runs[runId];
  }

  patchRun(runId: string, patch: Partial<Run>): Run {
    const run = this.data.runs[runId];
    if (!run) throw new Error(`Unknown run: ${runId}`);
    const updated = RunSchema.parse({
      ...run,
      ...patch,
      id: run.id,
      updatedAt: new Date().toISOString(),
    });
    this.data.runs[runId] = updated;
    this.persist();
    return updated;
  }

  appendEvent(
    runId: string,
    type: EventType,
    payload: Record<string, unknown> = {},
  ): Event {
    const run = this.data.runs[runId];
    if (!run) throw new Error(`Unknown run: ${runId}`);
    const sequence = run.lastEventSequence + 1;
    const event = EventSchema.parse({
      id: randomUUID(),
      runId,
      sequence,
      type,
      timestamp: new Date().toISOString(),
      payload,
    });
    this.data.events.push(event);
    this.data.runs[runId] = {
      ...run,
      lastEventSequence: sequence,
      updatedAt: event.timestamp,
    };
    this.persist();
    return event;
  }

  listEvents(runId: string, afterSequence = 0): Event[] {
    return this.data.events
      .filter((e) => e.runId === runId && e.sequence > afterSequence)
      .sort((a, b) => a.sequence - b.sequence);
  }

  saveCheckpoint(checkpoint: Checkpoint): Checkpoint {
    const parsed = CheckpointSchema.parse(checkpoint);
    this.data.checkpoints[parsed.runId] = parsed;
    this.persist();
    return parsed;
  }

  getCheckpoint(runId: string): Checkpoint | undefined {
    return this.data.checkpoints[runId];
  }

  /**
   * Append `checkpoint_saved` and store a checkpoint that covers it, in one
   * atomic write, so `checkpoint.lastEventSequence === run.lastEventSequence`
   * and `checkpoint.runState === run.state` right after a save.
   */
  saveCheckpointWithEvent(
    checkpoint: Omit<Checkpoint, "lastEventSequence" | "runState">,
  ): Checkpoint {
    return this.transact((draft) => {
      const run = draft.runs[checkpoint.runId];
      if (!run) throw new Error(`Unknown run: ${checkpoint.runId}`);
      const sequence = run.lastEventSequence + 1;
      const event = EventSchema.parse({
        id: randomUUID(),
        runId: run.id,
        sequence,
        type: "checkpoint_saved",
        timestamp: new Date().toISOString(),
        payload: { sequence },
      });
      draft.events.push(event);
      draft.runs[run.id] = { ...run, lastEventSequence: sequence, updatedAt: event.timestamp };
      const parsed = CheckpointSchema.parse({
        ...checkpoint,
        runState: run.state,
        lastEventSequence: sequence,
      });
      draft.checkpoints[run.id] = parsed;
      return parsed;
    });
  }

  getProviderSwitch(requestId: string): ProviderSwitchRecord | undefined {
    return this.data.providerSwitches[requestId];
  }

  listProviderSwitches(runId: string): ProviderSwitchRecord[] {
    return Object.values(this.data.providerSwitches)
      .filter((r) => r.runId === runId)
      .sort((a, b) => a.atEventSequence - b.atEventSequence);
  }

  /**
   * Commit a provider switch atomically (W10 P1-4): the run's provider/model,
   * the new checkpoint, a `provider_switched` event and the idempotency
   * record are written in one snapshot. Re-reads disk first and refuses if
   * the run moved past `expectedLastEventSequence` (optimistic concurrency).
   * A repeated `requestId` for the same switch is a no-op.
   */
  commitProviderSwitch(args: {
    requestId: string;
    runId: string;
    expectedLastEventSequence: number;
    runPatch: Pick<Run, "providerId" | "modelId"> & Partial<Pick<Run, "budget">>;
    checkpoint: Omit<Checkpoint, "lastEventSequence" | "runState">;
    handoffDigest: string;
    eventPayload?: Record<string, unknown>;
  }): CommitSwitchResult {
    this.reload();
    const existing = this.data.providerSwitches[args.requestId];
    if (existing) {
      const to = `${args.runPatch.providerId}/${args.runPatch.modelId}`;
      if (existing.runId !== args.runId || existing.to !== to) {
        return {
          ok: false,
          reason: "request_id_conflict",
          detail: `Switch request ${args.requestId} was already used for ${existing.runId} -> ${existing.to}.`,
        };
      }
      return { ok: true, duplicate: true, run: this.data.runs[args.runId]!, record: existing };
    }
    const current = this.data.runs[args.runId];
    if (!current) return { ok: false, reason: "unknown_run", detail: `Unknown run: ${args.runId}` };
    if (current.lastEventSequence !== args.expectedLastEventSequence) {
      return {
        ok: false,
        reason: "stale_run",
        detail: `Run moved to sequence ${current.lastEventSequence}; switch was validated at ${args.expectedLastEventSequence}.`,
      };
    }
    return this.transact((draft) => {
      const run = draft.runs[args.runId]!;
      const sequence = run.lastEventSequence + 1;
      const at = new Date().toISOString();
      const from = `${run.providerId}/${run.modelId}`;
      const to = `${args.runPatch.providerId}/${args.runPatch.modelId}`;
      draft.events.push(
        EventSchema.parse({
          id: randomUUID(),
          runId: run.id,
          sequence,
          type: "provider_switched",
          timestamp: at,
          payload: { requestId: args.requestId, from, to, handoffDigest: args.handoffDigest, ...(args.eventPayload ?? {}) },
        }),
      );
      const nextRun = RunSchema.parse({
        ...run,
        ...args.runPatch,
        id: run.id,
        lastEventSequence: sequence,
        updatedAt: at,
      });
      draft.runs[run.id] = nextRun;
      const checkpoint = CheckpointSchema.parse({
        ...args.checkpoint,
        runId: run.id,
        runState: nextRun.state,
        lastEventSequence: sequence,
      });
      draft.checkpoints[run.id] = checkpoint;
      const record: ProviderSwitchRecord = {
        requestId: args.requestId,
        runId: run.id,
        from,
        to,
        atEventSequence: sequence,
        handoffDigest: args.handoffDigest,
        committedAt: at,
      };
      draft.providerSwitches[args.requestId] = record;
      return { ok: true as const, duplicate: false as const, run: nextRun, checkpoint, record };
    });
  }

  private toolKey(runId: string, callId: string): string {
    return `${runId}:${callId}`;
  }

  upsertToolCall(call: ToolCall): ToolCall {
    const parsed = ToolCallSchema.parse(call);
    if (!this.data.runs[parsed.runId]) {
      throw new Error(`Unknown run: ${parsed.runId}`);
    }
    this.data.toolCalls[this.toolKey(parsed.runId, parsed.id)] = parsed;
    this.persist();
    return parsed;
  }

  listToolCalls(runId: string): ToolCall[] {
    return Object.values(this.data.toolCalls)
      .filter((c) => c.runId === runId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Acquire an exclusive lease for a run. Duplicate resume is rejected
   * while another holder owns a non-expired lease.
   */
  acquireLease(
    runId: string,
    holderId: string,
    ttlMs = 60_000,
  ): { ok: true } | { ok: false; reason: string; holderId?: string } {
    this.reload();
    if (!this.data.runs[runId]) {
      return { ok: false, reason: `Unknown run: ${runId}` };
    }
    const now = Date.now();
    const existing = this.data.leases[runId];
    if (
      existing &&
      existing.holderId !== holderId &&
      Date.parse(existing.expiresAt) > now
    ) {
      return {
        ok: false,
        reason: "Run lease held by another process",
        holderId: existing.holderId,
      };
    }
    this.data.leases[runId] = {
      holderId,
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    this.persist();
    return { ok: true };
  }

  releaseLease(runId: string, holderId: string): void {
    this.reload();
    const existing = this.data.leases[runId];
    if (existing?.holderId === holderId) {
      delete this.data.leases[runId];
      this.persist();
    }
  }
}
