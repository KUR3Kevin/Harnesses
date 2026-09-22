import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeRequestSchema,
  BridgeResponseSchema,
  PROTOCOL_VERSION,
} from "./index.js";

describe("bridge protocol", () => {
  it("shares PROTOCOL_VERSION", () => {
    assert.equal(BRIDGE_PROTOCOL_VERSION, PROTOCOL_VERSION);
  });

  it("parses start_run and subscribe_events shapes", () => {
    const start = BridgeRequestSchema.parse({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: "r1",
      command: "start_run",
      params: {
        task: {
          id: "t1",
          projectId: "p1",
          goal: "g",
          scope: [],
          mode: "run",
          acceptanceCriteria: [],
        },
        workspaceRoot: "/tmp/ws",
        dataDir: "/tmp/data",
      },
    });
    assert.equal(start.command, "start_run");

    const sub = BridgeRequestSchema.parse({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: "r2",
      command: "subscribe_events",
      params: { runId: "run-1", afterSequence: 3 },
    });
    assert.equal(sub.command, "subscribe_events");
    if (sub.command === "subscribe_events") {
      assert.equal(sub.params.afterSequence, 3);
    }
  });

  it("parses ok response with events", () => {
    const res = BridgeResponseSchema.parse({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: "r1",
      ok: true,
      events: [],
    });
    assert.equal(res.ok, true);
  });
});
