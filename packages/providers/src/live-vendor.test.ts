import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StreamEventSchema, type ModelProvider, type StreamEvent } from "@kur3/contracts";
import { AnthropicMessagesProvider } from "./anthropic-messages-provider.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";

/**
 * P1-6 opt-in LIVE vendor check. Skipped by default; never runs in CI or in
 * `npm test` unless KUR3_LIVE_VENDOR_TESTS=1 AND the matching key env var is
 * set. Keys are read from the environment only and are never logged.
 *
 *   KUR3_LIVE_VENDOR_TESTS=1 ANTHROPIC_API_KEY=... KUR3_ANTHROPIC_MODEL=... \
 *   OPENAI_API_KEY=... KUR3_OPENAI_MODEL=... npm test -w @kur3/providers
 */
const LIVE = process.env.KUR3_LIVE_VENDOR_TESTS === "1";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";

async function liveTurn(p: ModelProvider, modelId: string): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of p.stream({
    modelId,
    messages: [{ role: "user", content: "Call read_file with path src/hello.ts. Do nothing else." }],
    tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
  })) {
    StreamEventSchema.parse(ev);
    out.push(ev);
  }
  return out;
}

describe("LIVE vendor streaming (opt-in)", () => {
  it("Anthropic Messages: real stream satisfies the StreamEvent contract", { skip: !(LIVE && ANTHROPIC_KEY) && "set KUR3_LIVE_VENDOR_TESTS=1 and ANTHROPIC_API_KEY" }, async () => {
    const p = new AnthropicMessagesProvider({ baseUrl: process.env.KUR3_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1", apiKey: ANTHROPIC_KEY });
    const evs = await liveTurn(p, process.env.KUR3_ANTHROPIC_MODEL ?? "claude-sonnet-4-5");
    assert.ok(!evs.some((e) => e.type === "error"), JSON.stringify(evs.filter((e) => e.type === "error")));
    assert.equal(evs.at(-1)?.type, "completed");
    assert.ok(!JSON.stringify(evs).includes(ANTHROPIC_KEY));
  });

  it("OpenAI Chat Completions: real stream satisfies the StreamEvent contract", { skip: !(LIVE && OPENAI_KEY) && "set KUR3_LIVE_VENDOR_TESTS=1 and OPENAI_API_KEY" }, async () => {
    const p = new OpenAICompatibleProvider({ baseUrl: process.env.KUR3_OPENAI_BASE_URL ?? "https://api.openai.com/v1", apiKey: OPENAI_KEY });
    const evs = await liveTurn(p, process.env.KUR3_OPENAI_MODEL ?? "gpt-4o-mini");
    assert.ok(!evs.some((e) => e.type === "error"), JSON.stringify(evs.filter((e) => e.type === "error")));
    assert.equal(evs.at(-1)?.type, "completed");
    assert.ok(!JSON.stringify(evs).includes(OPENAI_KEY));
  });
});
