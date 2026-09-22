import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canTransition, RunStateSchema } from "./run-states.js";

describe("run states", () => {
  it("parses known states", () => {
    assert.equal(RunStateSchema.parse("running"), "running");
  });

  it("allows queued -> running", () => {
    assert.equal(canTransition("queued", "running"), true);
  });

  it("rejects completed -> running", () => {
    assert.equal(canTransition("completed", "running"), false);
  });
});
