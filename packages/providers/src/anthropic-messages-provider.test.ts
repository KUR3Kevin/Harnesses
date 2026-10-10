import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StreamEventSchema, type StreamEvent } from "@kur3/contracts";
import { AnthropicMessagesProvider, toAnthropicMessages } from "./anthropic-messages-provider.js";
import type { FetchLike } from "./http-transport.js";

const KEY = "sk-ant-test-not-real-123456";

function sse(events: Array<[string, unknown]>): string {
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
}
function mock(body: string, status = 200, seen?: { url?: string; init?: RequestInit }): FetchLike {
  return async (url, init) => {
    if (seen) {
      seen.url = String(url);
      seen.init = init;
    }
    return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
  };
}
async function run(p: AnthropicMessagesProvider, ac?: AbortController): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of p.stream(
    {
      modelId: "m",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      tools: [{ name: "read_file", description: "r", inputSchema: { type: "object" } }],
    },
    ac?.signal,
  )) {
    StreamEventSchema.parse(ev);
    out.push(ev);
  }
  return out;
}
const mk = (f: FetchLike) =>
  new AnthropicMessagesProvider({ baseUrl: "https://example.test/v1/", apiKey: KEY, fetch: f });

describe("AnthropicMessagesProvider (mocked)", () => {
  it("sends Messages wire format: x-api-key, top-level system, input_schema", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    await run(mk(mock(sse([["message_start", { type: "message_start", message: {} }], ["message_stop", { type: "message_stop" }]]), 200, seen)));
    assert.equal(seen.url, "https://example.test/v1/messages");
    const h = seen.init!.headers as Record<string, string>;
    assert.equal(h["x-api-key"], KEY);
    assert.equal(h["anthropic-version"], "2023-06-01");
    assert.equal(h.Authorization, undefined);
    const body = JSON.parse(String(seen.init!.body));
    assert.equal(body.system, "sys");
    assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
    assert.deepEqual(body.tools[0].input_schema, { type: "object" });
  });

  it("text, buffered tool_use, usage, finish mapping; thinking dropped", async () => {
    const body = sse([
      ["message_start", { type: "message_start", message: { usage: { input_tokens: 12 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "SECRET-REASONING" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "OPAQUE-SIG" } }],
      ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hel" } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "lo" } }],
      ["content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} } }],
      ["content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"pa' } }],
      ["content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: 'th":"a.ts"}' } }],
      ["content_block_stop", { type: "content_block_stop", index: 2 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }],
      ["message_stop", { type: "message_stop" }],
    ]);
    const evs = await run(mk(mock(body)));
    const text = evs.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
    assert.equal(text, "Hello");
    assert.ok(!JSON.stringify(evs).includes("SECRET-REASONING"));
    assert.ok(!JSON.stringify(evs).includes("OPAQUE-SIG"));
    const tool = evs.find((e) => e.type === "tool_request");
    assert.deepEqual(tool, { type: "tool_request", callId: "toolu_1", name: "read_file", input: { path: "a.ts" } });
    assert.deepEqual(evs.find((e) => e.type === "usage"), { type: "usage", inputTokens: 12, outputTokens: 7 });
    assert.deepEqual(evs.at(-1), { type: "completed", finishReason: "tool_calls" });
  });

  it("malformed tool JSON never becomes tool_request", async () => {
    const body = sse([
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "x" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{bad" } }],
      ["message_stop", { type: "message_stop" }],
    ]);
    const evs = await run(mk(mock(body)));
    assert.ok(!evs.some((e) => e.type === "tool_request"));
    assert.ok(evs.some((e) => e.type === "error" && e.code === "malformed_tool_args"));
  });

  it("no usage event invented when provider reports none", async () => {
    const evs = await run(mk(mock(sse([["message_stop", { type: "message_stop" }]]))));
    assert.ok(!evs.some((e) => e.type === "usage"));
  });

  it("HTTP 401 → auth, key redacted; 429 → rate_limit; stream error event mapped", async () => {
    const a = await run(mk(mock(`bad key ${KEY}`, 401)));
    assert.equal(a[0]!.type === "error" && a[0]!.code, "auth");
    assert.ok(!JSON.stringify(a).includes(KEY));
    const r = await run(mk(mock("slow", 429)));
    assert.equal(r[0]!.type === "error" && r[0]!.code, "rate_limit");
    const o = await run(mk(mock(sse([["error", { type: "error", error: { type: "overloaded_error", message: "busy" } }]]))));
    assert.equal(o.at(-1)!.type === "error" && (o.at(-1) as { code: string }).code, "rate_limit");
  });

  it("truncated stream / bad JSON / network / abort map to canonical codes", async () => {
    const t = await run(mk(mock(sse([["message_start", { type: "message_start", message: {} }]]))));
    assert.equal(t.at(-1)!.type === "error" && (t.at(-1) as { code: string }).code, "malformed_sse");
    const b = await run(mk(mock("event: x\ndata: {nope\n\n")));
    assert.equal((b.at(-1) as { code: string }).code, "malformed_sse");
    const n = await run(mk(async () => { throw new TypeError("fetch failed"); }));
    assert.equal((n[0] as { code: string }).code, "network");
    const ac = new AbortController();
    ac.abort();
    const ab = await run(mk(mock("")), ac);
    assert.equal((ab[0] as { code: string }).code, "aborted");
  });

  it("toAnthropicMessages: tool results become user text, roles alternate", () => {
    const { system, messages } = toAnthropicMessages([
      { role: "system", content: "s" },
      { role: "assistant", content: "a" },
      { role: "tool", content: "out", toolCallId: "c1", name: "read_file" },
      { role: "user", content: "u" },
    ]);
    assert.equal(system, "s");
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user"]);
    assert.match(messages[2]!.content, /\[tool result read_file c1\]\nout\n\nu/);
  });
});
