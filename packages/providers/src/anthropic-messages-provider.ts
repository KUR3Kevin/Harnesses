import type {
  ModelProvider,
  ProviderCapabilities,
  ProviderMessage,
  ProviderRequest,
  StreamEvent,
} from "@kur3/contracts";
import { defaultTransport, type FetchLike, type HttpTransport } from "./http-transport.js";
import {
  normalizeHttpError,
  normalizeTransportError,
  redactSecrets,
} from "./openai-compatible-errors.js";

/**
 * W10 second adapter: Anthropic-Messages-style wire format.
 *
 * Differs from the OpenAI-compatible adapter on purpose:
 * - `x-api-key` + `anthropic-version` headers (no Bearer).
 * - `system` is a top-level field, not a message.
 * - Named SSE events (`message_start`, `content_block_*`, `message_delta`, ...).
 * - Tool args arrive as `input_json_delta` fragments per content block.
 * - Usage split across `message_start` (input) and `message_delta` (output).
 *
 * Opaque provider state (`thinking` / `redacted_thinking` blocks, signatures)
 * is never surfaced as a StreamEvent, so it cannot reach a checkpoint.
 * Network is injectable; tests use mocks only.
 */
export interface AnthropicMessagesProviderOptions {
  id?: string;
  /** e.g. https://api.anthropic.com/v1 (no trailing slash). */
  baseUrl: string;
  apiKey: string;
  fetch?: FetchLike;
  transport?: HttpTransport;
  anthropicVersion?: string;
  maxTokens?: number;
  messagesPath?: string;
}

interface BlockBuffer {
  kind: "text" | "tool_use" | "opaque";
  id: string;
  name: string;
  json: string;
}

export class AnthropicMessagesProvider implements ModelProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly transport: HttpTransport;
  private readonly version: string;
  private readonly maxTokens: number;
  private readonly path: string;

  constructor(opts: AnthropicMessagesProviderOptions) {
    this.id = opts.id ?? "anthropic-messages";
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.transport =
      opts.transport ?? (opts.fetch ? { fetch: opts.fetch } : defaultTransport());
    this.version = opts.anthropicVersion ?? "2023-06-01";
    this.maxTokens = opts.maxTokens ?? 4096;
    this.path = opts.messagesPath ?? "/messages";
  }

  capabilities(): ProviderCapabilities {
    return {
      nativeTools: true,
      structuredOutput: false,
      streaming: true,
      reasoningControls: false,
    };
  }

  /** Exposed for tests: the exact request body sent on the wire. */
  buildBody(request: ProviderRequest): Record<string, unknown> {
    const { system, messages } = toAnthropicMessages(request.messages);
    const body: Record<string, unknown> = {
      model: request.modelId,
      max_tokens: this.maxTokens,
      stream: true,
      messages,
    };
    if (system) body.system = system;
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }
    return body;
  }

  async *stream(
    request: ProviderRequest,
    abortSignal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    if (abortSignal?.aborted) {
      yield { type: "error", code: "aborted", message: "Request aborted" };
      return;
    }
    let response: Response;
    try {
      response = await this.transport.fetch(`${this.baseUrl}${this.path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "x-api-key": this.apiKey,
          "anthropic-version": this.version,
        },
        body: JSON.stringify(this.buildBody(request)),
        signal: abortSignal,
      });
    } catch (err) {
      const n = normalizeTransportError(err, abortSignal);
      yield { type: "error", code: n.code, message: this.scrub(n.message) };
      return;
    }
    if (!response.ok) {
      let raw = "";
      try {
        raw = await response.text();
      } catch {
        raw = "";
      }
      const n = normalizeHttpError(response.status, raw);
      yield { type: "error", code: n.code, message: this.scrub(n.message) };
      return;
    }
    if (!response.body) {
      yield { type: "error", code: "provider_error", message: "Provider response missing body" };
      return;
    }

    const blocks = new Map<number, BlockBuffer>();
    let finishReason: "stop" | "tool_calls" | "length" | "error" = "stop";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let sawStop = false;

    try {
      for await (const { event, data } of readNamedSse(response.body, abortSignal)) {
        if (abortSignal?.aborted) {
          yield { type: "error", code: "aborted", message: "Request aborted" };
          return;
        }
        let payload: Record<string, any>;
        try {
          payload = JSON.parse(data) as Record<string, any>;
        } catch {
          yield { type: "error", code: "malformed_sse", message: "Malformed SSE JSON event" };
          return;
        }
        const type = (payload.type as string | undefined) ?? event;
        if (type === "ping") continue;
        if (type === "error") {
          const e = payload.error ?? {};
          const code = e.type === "overloaded_error" || e.type === "rate_limit_error"
            ? "rate_limit"
            : e.type === "authentication_error"
              ? "auth"
              : "provider_error";
          yield {
            type: "error",
            code,
            message: this.scrub(String(e.message ?? e.type ?? "Provider error")),
          };
          return;
        }
        if (type === "message_start") {
          const u = payload.message?.usage;
          if (typeof u?.input_tokens === "number") inputTokens = u.input_tokens;
          if (typeof u?.output_tokens === "number") outputTokens = u.output_tokens;
          continue;
        }
        if (type === "content_block_start") {
          const cb = payload.content_block ?? {};
          const kind: BlockBuffer["kind"] =
            cb.type === "text" ? "text" : cb.type === "tool_use" ? "tool_use" : "opaque";
          blocks.set(payload.index ?? 0, {
            kind,
            id: typeof cb.id === "string" ? cb.id : "",
            name: typeof cb.name === "string" ? cb.name : "",
            json: "",
          });
          if (kind === "text" && typeof cb.text === "string" && cb.text) {
            yield { type: "text_delta", text: cb.text };
          }
          continue;
        }
        if (type === "content_block_delta") {
          const buf = blocks.get(payload.index ?? 0);
          const d = payload.delta ?? {};
          if (!buf || buf.kind === "opaque") continue; // thinking/signature: dropped
          if (d.type === "text_delta" && buf.kind === "text" && typeof d.text === "string") {
            yield { type: "text_delta", text: d.text };
          } else if (d.type === "input_json_delta" && buf.kind === "tool_use") {
            buf.json += typeof d.partial_json === "string" ? d.partial_json : "";
          }
          continue;
        }
        if (type === "content_block_stop") continue; // tool emitted after stream ends
        if (type === "message_delta") {
          if (payload.delta?.stop_reason) finishReason = mapStop(payload.delta.stop_reason);
          if (typeof payload.usage?.output_tokens === "number") {
            outputTokens = payload.usage.output_tokens;
          }
          continue;
        }
        if (type === "message_stop") {
          sawStop = true;
          break;
        }
      }
    } catch (err) {
      const n = normalizeTransportError(err, abortSignal);
      yield { type: "error", code: n.code, message: this.scrub(n.message) };
      return;
    }

    if (!sawStop) {
      yield {
        type: "error",
        code: "malformed_sse",
        message: "Stream ended without message_stop",
      };
      return;
    }

    for (const index of [...blocks.keys()].sort((a, b) => a - b)) {
      const buf = blocks.get(index)!;
      if (buf.kind !== "tool_use") continue;
      if (!buf.name) {
        yield { type: "error", code: "malformed_tool_args", message: `Tool block ${index} missing name` };
        continue;
      }
      const callId = buf.id || `tool-${index}`;
      let parsed: unknown;
      try {
        parsed = buf.json.trim() === "" ? {} : JSON.parse(buf.json);
      } catch {
        yield {
          type: "error",
          code: "malformed_tool_args",
          message: `Malformed tool arguments for ${buf.name} (call ${callId})`,
        };
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        yield {
          type: "error",
          code: "malformed_tool_args",
          message: `Tool arguments for ${buf.name} must be a JSON object`,
        };
        continue;
      }
      yield { type: "tool_request", callId, name: buf.name, input: parsed as Record<string, unknown> };
    }

    if (inputTokens !== undefined || outputTokens !== undefined) {
      yield { type: "usage", inputTokens, outputTokens };
    }
    yield { type: "completed", finishReason };
  }

  private scrub(text: string): string {
    let out = redactSecrets(text);
    if (this.apiKey) out = out.split(this.apiKey).join("[REDACTED]");
    return out;
  }
}

/**
 * Portable ProviderMessage[] → Messages API shape.
 * - system messages are joined into the top-level `system` string.
 * - `tool` results are rendered as plain user text: the portable transcript
 *   carries no matching assistant `tool_use` block, and the Messages API
 *   rejects an orphan `tool_result`. Unsupported shapes are converted, never
 *   forwarded raw.
 * - consecutive same-role turns are merged (API requires alternation).
 */
export function toAnthropicMessages(input: ProviderMessage[]): {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const systems: string[] = [];
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of input) {
    if (m.role === "system") {
      systems.push(m.content);
      continue;
    }
    const role: "user" | "assistant" = m.role === "assistant" ? "assistant" : "user";
    const content =
      m.role === "tool"
        ? `[tool result${m.name ? ` ${m.name}` : ""}${m.toolCallId ? ` ${m.toolCallId}` : ""}]\n${m.content}`
        : m.content;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else out.push({ role, content });
  }
  if (out.length === 0 || out[0]!.role !== "user") {
    out.unshift({ role: "user", content: "(continue)" });
  }
  return { system: systems.length ? systems.join("\n\n") : undefined, messages: out };
}

function mapStop(reason: string): "stop" | "tool_calls" | "length" | "error" {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return "error";
  }
}

async function* readNamedSse(
  body: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (raw: string) => {
    let event = "";
    const data: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    return data.length ? { event, data: data.join("\n") } : undefined;
  };
  try {
    while (true) {
      if (abortSignal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const ev = parse(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
        if (ev) yield ev;
      }
    }
    if (buffer.trim()) {
      const ev = parse(buffer);
      if (ev) yield ev;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}
