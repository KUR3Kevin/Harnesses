import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StreamEvent } from "@kur3/contracts";
import type { FetchLike } from "./http-transport.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";
import { redactSecrets } from "./openai-compatible-errors.js";

function sseResponse(chunks: string[], init?: ResponseInit): Response {
  const body = chunks.map((c) => `data: ${c}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    ...init,
  });
}

function jsonChunk(partial: Record<string, unknown>): string {
  return JSON.stringify(partial);
}

async function collect(
  provider: OpenAICompatibleProvider,
  messages: {
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    name?: string;
    toolCallId?: string;
  }[],
  abortSignal?: AbortSignal,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of provider.stream(
    {
      modelId: "test-model",
      messages,
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ],
    },
    abortSignal,
  )) {
    events.push(ev);
  }
  return events;
}

function makeProvider(fetchImpl: FetchLike): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    baseUrl: "https://example.test/v1",
    apiKey: "sk-test-secret-key-do-not-log",
    fetch: fetchImpl,
  });
}

describe("OpenAICompatibleProvider conformance (mocked)", () => {
  it("reports streaming + native tool capabilities", () => {
    const p = makeProvider(async () => new Response("{}", { status: 500 }));
    const caps = p.capabilities();
    assert.equal(caps.streaming, true);
    assert.equal(caps.nativeTools, true);
    assert.equal(p.id, "openai-compatible");
  });

  it("streams text deltas and completes", async () => {
    const fetchImpl: FetchLike = async () =>
      sseResponse([
        jsonChunk({
          choices: [{ index: 0, delta: { content: "Hello" } }],
        }),
        jsonChunk({
          choices: [{ index: 0, delta: { content: " world" }, finish_reason: "stop" }],
        }),
        jsonChunk({
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }),
      ]);
    const events = await collect(makeProvider(fetchImpl), [
      { role: "user", content: "hi" },
    ]);
    const texts = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""));
    assert.deepEqual(texts, ["Hello", " world"]);
    const usage = events.find((e) => e.type === "usage");
    assert.ok(usage && usage.type === "usage");
    assert.equal(usage.inputTokens, 10);
    assert.equal(usage.outputTokens, 4);
    const done = events.find((e) => e.type === "completed");
    assert.ok(done && done.type === "completed");
    assert.equal(done.finishReason, "stop");
  });

  it("assembles fragmented tool-call JSON into one tool_request", async () => {
    const fetchImpl: FetchLike = async () =>
      sseResponse([
        jsonChunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "read_file", arguments: "" },
                  },
                ],
              },
            },
          ],
        }),
        jsonChunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '{"path":' } },
                ],
              },
            },
          ],
        }),
        jsonChunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '"src/hello.ts"}' } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      ]);
    const events = await collect(makeProvider(fetchImpl), [
      { role: "user", content: "read it" },
    ]);
    const tool = events.find((e) => e.type === "tool_request");
    assert.ok(tool && tool.type === "tool_request");
    assert.equal(tool.callId, "call_1");
    assert.equal(tool.name, "read_file");
    assert.deepEqual(tool.input, { path: "src/hello.ts" });
    const done = events.find((e) => e.type === "completed");
    assert.ok(done && done.type === "completed");
    assert.equal(done.finishReason, "tool_calls");
    // No partial tool_request emitted mid-stream
    assert.equal(events.filter((e) => e.type === "tool_request").length, 1);
  });

  it("never emits tool_request for malformed tool args (adapter-level)", async () => {
    const fetchImpl: FetchLike = async () =>
      sseResponse([
        jsonChunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_bad",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: '{"path": NOT_JSON',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      ]);
    const events = await collect(makeProvider(fetchImpl), [
      { role: "user", content: "bad tool" },
    ]);
    assert.equal(
      events.filter((e) => e.type === "tool_request").length,
      0,
      "malformed args must not become tool_request",
    );
    const err = events.find((e) => e.type === "error");
    assert.ok(err && err.type === "error");
    assert.equal(err.code, "malformed_tool_args");
  });

  it("maps HTTP 401 to auth error without leaking api key", async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      assert.ok(auth?.includes("sk-test-secret"));
      return new Response(
        JSON.stringify({ error: { message: "Invalid API key sk-test-secret-key-do-not-log" } }),
        { status: 401 },
      );
    };
    const events = await collect(makeProvider(fetchImpl), [
      { role: "user", content: "x" },
    ]);
    const err = events.find((e) => e.type === "error");
    assert.ok(err && err.type === "error");
    assert.equal(err.code, "auth");
    assert.equal(err.message.includes("sk-test-secret"), false);
    assert.ok(err.message.includes("[REDACTED]") || !err.message.includes("sk-"));
  });

  it("maps HTTP 429 to rate_limit", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("rate limit exceeded", { status: 429 });
    const events = await collect(makeProvider(fetchImpl), [
      { role: "user", content: "x" },
    ]);
    const err = events.find((e) => e.type === "error");
    assert.ok(err && err.type === "error");
    assert.equal(err.code, "rate_limit");
  });

  it("honors AbortSignal (pre-aborted)", async () => {
    let fetchCalled = false;
    const fetchImpl: FetchLike = async () => {
      fetchCalled = true;
      return sseResponse([]);
    };
    const ac = new AbortController();
    ac.abort();
    const events = await collect(
      makeProvider(fetchImpl),
      [{ role: "user", content: "x" }],
      ac.signal,
    );
    assert.equal(fetchCalled, false);
    const err = events.find((e) => e.type === "error");
    assert.ok(err && err.type === "error");
    assert.equal(err.code, "aborted");
  });

  it("honors AbortSignal during fetch", async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      const signal = init?.signal;
      assert.ok(signal);
      return await new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    };
    const ac = new AbortController();
    const p = makeProvider(fetchImpl);
    const iter = p.stream(
      { modelId: "test-model", messages: [{ role: "user", content: "x" }] },
      ac.signal,
    );
    const pending = (async () => {
      const events: StreamEvent[] = [];
      for await (const ev of iter) events.push(ev);
      return events;
    })();
    ac.abort();
    const events = await pending;
    const err = events.find((e) => e.type === "error");
    assert.ok(err && err.type === "error");
    assert.equal(err.code, "aborted");
  });

  it("normalizes usage fields from OpenAI prompt/completion tokens", async () => {
    const fetchImpl: FetchLike = async () =>
      sseResponse([
        jsonChunk({
          choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
        }),
        jsonChunk({
          choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
      ]);
    const events = await collect(makeProvider(fetchImpl), [
      { role: "user", content: "usage" },
    ]);
    const usage = events.find((e) => e.type === "usage");
    assert.ok(usage && usage.type === "usage");
    assert.equal(usage.inputTokens, 100);
    assert.equal(usage.outputTokens, 20);
  });

  it("redactSecrets strips bearer tokens and sk- keys", () => {
    const raw =
      'Authorization: Bearer sk-live-abcdef Authorization Bearer xyz and sk-proj-12345';
    const cleaned = redactSecrets(raw);
    assert.equal(cleaned.includes("sk-live"), false);
    assert.equal(cleaned.includes("Bearer xyz"), false);
  });

  it("does not call real network — mock fetch receives expected URL", async () => {
    let seenUrl = "";
    const fetchImpl: FetchLike = async (input) => {
      seenUrl = String(input);
      return sseResponse([
        jsonChunk({
          choices: [{ index: 0, delta: { content: "n" }, finish_reason: "stop" }],
        }),
      ]);
    };
    await collect(makeProvider(fetchImpl), [{ role: "user", content: "n" }]);
    assert.equal(seenUrl, "https://example.test/v1/chat/completions");
  });
});
