import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeProvider } from "./fake-provider.js";

async function collect(provider: FakeProvider, messages: { role: "user" | "assistant" | "system" | "tool"; content: string; name?: string }[]) {
  const events = [];
  for await (const ev of provider.stream({ modelId: "fake-v1", messages })) {
    events.push(ev);
  }
  return events;
}

describe("FakeProvider", () => {
  it("reports offline capabilities", () => {
    const p = new FakeProvider();
    const caps = p.capabilities();
    assert.equal(caps.streaming, true);
    assert.equal(caps.nativeTools, true);
  });

  it("greet scenario yields text and completes", async () => {
    const p = new FakeProvider({ scenario: "greet" });
    const events = await collect(p, [{ role: "user", content: "hi" }]);
    assert.ok(events.some((e) => e.type === "text_delta"));
    assert.ok(events.some((e) => e.type === "completed"));
  });

  it("edit_hello first turn requests read_file", async () => {
    const p = new FakeProvider({ scenario: "edit_hello" });
    const events = await collect(p, [
      { role: "user", content: "edit hello" },
    ]);
    const tool = events.find((e) => e.type === "tool_request");
    assert.ok(tool && tool.type === "tool_request");
    assert.equal(tool.name, "read_file");
  });
});
