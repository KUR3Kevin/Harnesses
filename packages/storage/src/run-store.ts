import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  CheckpointSchema,
  EventSchema,
  RunSchema,
  type Checkpoint,
  type Event,
  type EventType,
  type Run,
  type RunState,
  canTransition,
} from "@kur3/contracts";

interface StoreData {
  version: 1;
  runs: Record<string, Run>;
  events: Event[];
  checkpoints: Record<string, Checkpoint>;
  leases: Record<string, { holderId: string; expiresAt: string }>;
}

function emptyData(): StoreData {
  return { version: 1, runs: {}, events: [], checkpoints: {}, leases: {} };
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
    const raw = JSON.parse(fs.readFileSync(this.dataPath, "utf8")) as StoreData;
    return raw;
  }

  private persist(): void {
    const tmp = `${this.dataPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(tmp, this.dataPath);
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
   * Acquire an exclusive lease for a run. Duplicate resume is rejected
   * while another holder owns a non-expired lease.
   */
  acquireLease(
    runId: string,
    holderId: string,
    ttlMs = 60_000,
  ): { ok: true } | { ok: false; reason: string; holderId?: string } {
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
    const existing = this.data.leases[runId];
    if (existing?.holderId === holderId) {
      delete this.data.leases[runId];
      this.persist();
    }
  }
}
