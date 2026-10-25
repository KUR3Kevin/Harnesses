/**
 * Recorded-shape SSE fixtures for contract tests (P1-6).
 *
 * These are hand-transcribed from the vendors' PUBLISHED streaming examples,
 * not captured from a live account, and contain no keys:
 * - Anthropic Messages streaming ("Streaming Messages" docs): named events
 *   `message_start`, `content_block_start`, `ping`, `content_block_delta`
 *   (`text_delta` / `input_json_delta`), `content_block_stop`,
 *   `message_delta` (stop_reason + cumulative output usage), `message_stop`.
 * - OpenAI Chat Completions streaming: `chat.completion.chunk` objects with
 *   `choices[].delta` (`role`, `content`, `tool_calls[]` with `index`, `id`,
 *   `function.name`, `function.arguments` fragments), `finish_reason`, a final
 *   usage chunk with `choices: []` when `stream_options.include_usage` is
 *   set, then `data: [DONE]`.
 *
 * They are still NOT a substitute for a real-key run; see the opt-in
 * live-vendor test and docs/STEP4-W10-CHANGE-SUMMARY.md.
 */

function named(events: Array<[string, unknown]>): string {
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
}
function dataOnly(chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

const msg = {
  id: "msg_01FixtureExample",
  type: "message",
  role: "assistant",
  content: [],
  model: "claude-fixture",
  stop_reason: null,
  stop_sequence: null,
  usage: { input_tokens: 472, output_tokens: 2 },
};

/** Anthropic: text block then a tool_use block (docs "tool use" stream example shape). */
export const ANTHROPIC_TOOL_USE_STREAM = named([
  ["message_start", { type: "message_start", message: msg }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["ping", { type: "ping" }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Okay, let me check" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " the file." } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  [
    "content_block_start",
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_01FixtureRead", name: "read_file", input: {} } },
  ],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path": "src/' } }],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'hello.ts"}' } }],
  ["content_block_stop", { type: "content_block_stop", index: 1 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 89 } }],
  ["message_stop", { type: "message_stop" }],
]);

/** Anthropic: plain text turn ending with end_turn. */
export const ANTHROPIC_TEXT_STREAM = named([
  ["message_start", { type: "message_start", message: msg }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["ping", { type: "ping" }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 15 } }],
  ["message_stop", { type: "message_stop" }],
]);

/** Anthropic: mid-stream error event (docs: overloaded_error). */
export const ANTHROPIC_ERROR_STREAM = named([
  ["message_start", { type: "message_start", message: msg }],
  ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }],
]);

const base = { id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1700000000, model: "gpt-fixture", system_fingerprint: "fp_fixture" };

/** OpenAI: fragmented tool call + include_usage final chunk. */
export const OPENAI_TOOL_CALL_STREAM = dataOnly([
  { ...base, choices: [{ index: 0, delta: { role: "assistant", content: null }, logprobs: null, finish_reason: null }] },
  {
    ...base,
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, id: "call_FixtureRead", type: "function", function: { name: "read_file", arguments: "" } }] },
        logprobs: null,
        finish_reason: null,
      },
    ],
  },
  { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] }, logprobs: null, finish_reason: null }] },
  { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ': "src/hello.ts"}' } }] }, logprobs: null, finish_reason: null }] },
  { ...base, choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: "tool_calls" }] },
  { ...base, choices: [], usage: { prompt_tokens: 82, completion_tokens: 17, total_tokens: 99 } },
]);

/** OpenAI: plain text stream. */
export const OPENAI_TEXT_STREAM = dataOnly([
  { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, logprobs: null, finish_reason: null }] },
  { ...base, choices: [{ index: 0, delta: { content: "Hello" }, logprobs: null, finish_reason: null }] },
  { ...base, choices: [{ index: 0, delta: { content: "!" }, logprobs: null, finish_reason: null }] },
  { ...base, choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: "stop" }] },
  { ...base, choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } },
]);
