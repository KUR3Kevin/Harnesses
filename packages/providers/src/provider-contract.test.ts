import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  StreamEventSchema,
  isModelProvider,
  isProviderErrorCode,
  type ModelProvider,
  type StreamEvent,
} from "@kur3/contracts";
import { FakeProvider } from "./fake-provider.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";
import { AnthropicMessagesProvider } from "./anthropic-messages-provider.js";
import type { FetchLike } from "./http-transport.js";

async function collect(
  provider: ModelProvider,
  abortSignal?: AbortSignal,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of provider.stream(
    {
      modelId: "contract-test",
      messages: [{ role: "user", content: "hi" }],
    },
    abortSignal,
  )) {
    events.push(ev);
  }
  return events;
}

describe("ModelProvider contract — both reference adapters", () => {
  it("FakeProvider satisfies isModelProvider and emits valid StreamEvents", async () => {
    const p = new FakeProvider({ scenario: "greet" });
    assert.equal(isModelProvider(p), true);
    const caps = p.capabilities();
    assert.equal(typeof caps.streaming, "boolean");
    const events = await collect(p);
    for (const ev of events) {
      StreamEventSchema.parse(ev);
    }
    assert.ok(events.some((e) => e.type === "completed"));
  });

  it("OpenAICompatibleProvider (mocked) satisfies the same contract", async () => {
    const fetchImpl: FetchLike = async () => {
      const body =
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n";
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };
    const p = new OpenAICompatibleProvider({
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test-not-real",
      fetch: fetchImpl,
    });
    assert.equal(isModelProvider(p), true);
    const events = await collect(p);
    for (const ev of events) {
      StreamEventSchema.parse(ev);
    }
    assert.ok(events.some((e) => e.type === "text_delta"));
    assert.ok(events.some((e) => e.type === "completed"));
  });

  it("FakeProvider abort uses canonical error code", async () => {
    const p = new FakeProvider({ scenario: "greet" });
    const ac = new AbortController();
    ac.abort();
    const events = await collect(p, ac.signal);
    const err = events.find((e) => e.type === "error");
    assert.ok(err && err.type === "error");
    assert.equal(isProviderErrorCode(err.code), true);
    assert.equal(err.code, "aborted");
  });
});

/**
 * W10: one conformance suite, run against every adapter (A15 exit check:
 * "two providers meet the same contract").
 */
const ADAPTERS: Array<{ name: string; make: () => ModelProvider }> = [
  { name: "FakeProvider", make: () => new FakeProvider({ scenario: "greet" }) },
  {
    name: "OpenAICompatibleProvider (mocked)",
    make: () =>
      new OpenAICompatibleProvider({
        baseUrl: "https://example.test/v1",
        apiKey: "sk-test-not-real",
        fetch: async () =>
          new Response(
            'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { status: 200 },
          ),
      }),
  },
  {
    name: "AnthropicMessagesProvider (mocked)",
    make: () =>
      new AnthropicMessagesProvider({
        baseUrl: "https://example.test/v1",
        apiKey: "sk-ant-test-not-real",
        fetch: async () =>
          new Response(
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
              'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n' +
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            { status: 200 },
          ),
      }),
  },
];

describe("ModelProvider conformance — shared suite (W10)", () => {
  for (const { name, make } of ADAPTERS) {
    it(`${name}: shape, valid events, exactly one terminal completed`, async () => {
      const p = make();
      assert.equal(isModelProvider(p), true);
      const caps = p.capabilities();
      assert.equal(typeof caps.streaming, "boolean");
      assert.equal(typeof caps.nativeTools, "boolean");
      const events = await collect(p);
      for (const ev of events) StreamEventSchema.parse(ev);
      assert.equal(events.filter((e) => e.type === "completed").length, 1);
      assert.equal(events.at(-1)?.type, "completed");
      assert.ok(!events.some((e) => e.type === "error"));
    });

    it(`${name}: pre-aborted signal yields canonical "aborted"`, async () => {
      const ac = new AbortController();
      ac.abort();
      const events = await collect(make(), ac.signal);
      const err = events.find((e) => e.type === "error");
      assert.ok(err && err.type === "error");
      assert.equal(isProviderErrorCode(err.code), true);
      assert.equal(err.code, "aborted");
      assert.ok(!events.some((e) => e.type === "completed"));
    });
  }
});
