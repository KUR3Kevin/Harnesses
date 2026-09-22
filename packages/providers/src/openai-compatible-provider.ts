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

export interface OpenAICompatibleProviderOptions {
  /** Adapter id (default: openai-compatible). */
  id?: string;
  /** API base without trailing slash, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  /** Bearer token — never logged or emitted in StreamEvent.error. */
  apiKey: string;
  /** Injectable fetch / transport for mocked conformance tests. */
  fetch?: FetchLike;
  transport?: HttpTransport;
  /** Extra headers (must not be logged if they contain secrets). */
  defaultHeaders?: Record<string, string>;
  /** Path under baseUrl (default: /chat/completions). */
  chatCompletionsPath?: string;
}

interface ToolCallBuffer {
  id: string;
  name: string;
  arguments: string;
}

interface ChatCompletionChunk {
  choices?: Array<{
    index?: number;
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; code?: string; type?: string };
}

/**
 * OpenAI-compatible Chat Completions streaming adapter.
 * Maps SSE chunks → StreamEvent; buffers tool-call JSON until valid.
 * HTTP is injectable — default tests never touch the network.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly defaultHeaders: Record<string, string>;
  private readonly chatPath: string;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.id = options.id ?? "openai-compatible";
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl =
      options.fetch ?? options.transport?.fetch ?? defaultTransport().fetch;
    this.defaultHeaders = { ...(options.defaultHeaders ?? {}) };
    this.chatPath = options.chatCompletionsPath ?? "/chat/completions";
  }

  capabilities(): ProviderCapabilities {
    return {
      nativeTools: true,
      structuredOutput: false,
      streaming: true,
      maxInputTokens: undefined,
      reasoningControls: false,
    };
  }

  async *stream(
    request: ProviderRequest,
    abortSignal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    if (abortSignal?.aborted) {
      yield { type: "error", code: "aborted", message: "Request aborted" };
      return;
    }

    const url = `${this.baseUrl}${this.chatPath.startsWith("/") ? this.chatPath : `/${this.chatPath}`}`;
    const body = {
      model: request.modelId,
      messages: request.messages.map(toOpenAIMessage),
      stream: true,
      stream_options: { include_usage: true },
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools.map((t) => ({
              type: "function",
              function: {
                name: t.name,
                description: t.description,
                parameters: t.inputSchema,
              },
            })),
          }
        : {}),
    };

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "text/event-stream",
          ...this.defaultHeaders,
        },
        body: JSON.stringify(body),
        signal: abortSignal,
      });
    } catch (err) {
      const normalized = normalizeTransportError(err, abortSignal);
      yield {
        type: "error",
        code: normalized.code,
        message: normalized.message,
      };
      return;
    }

    if (!response.ok) {
      const raw = await safeReadText(response);
      const normalized = normalizeHttpError(response.status, raw);
      yield {
        type: "error",
        code: normalized.code,
        message: normalized.message,
      };
      return;
    }

    if (!response.body) {
      yield {
        type: "error",
        code: "provider_error",
        message: "Provider response missing body",
      };
      return;
    }

    const toolBuffers = new Map<number, ToolCallBuffer>();
    let finishReason: "stop" | "tool_calls" | "length" | "error" = "stop";

    try {
      for await (const data of readSseDataLines(response.body, abortSignal)) {
        if (abortSignal?.aborted) {
          yield { type: "error", code: "aborted", message: "Request aborted" };
          return;
        }
        if (data === "[DONE]") {
          break;
        }

        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(data) as ChatCompletionChunk;
        } catch {
          yield {
            type: "error",
            code: "malformed_sse",
            message: "Malformed SSE JSON chunk",
          };
          return;
        }

        if (chunk.error) {
          yield {
            type: "error",
            code: "provider_error",
            message: redactSecrets(
              chunk.error.message ?? chunk.error.code ?? "Provider error",
            ),
          };
          return;
        }

        const choice = chunk.choices?.[0];
        const delta = choice?.delta;

        if (delta?.content) {
          yield { type: "text_delta", text: delta.content };
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index ?? 0;
            let buf = toolBuffers.get(index);
            if (!buf) {
              buf = { id: tc.id ?? "", name: "", arguments: "" };
              toolBuffers.set(index, buf);
            }
            if (tc.id) buf.id = tc.id;
            if (tc.function?.name) buf.name += tc.function.name;
            if (tc.function?.arguments) buf.arguments += tc.function.arguments;
          }
        }

        if (choice?.finish_reason) {
          finishReason = mapFinishReason(choice.finish_reason);
        }

        if (chunk.usage) {
          yield {
            type: "usage",
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          };
        }
      }
    } catch (err) {
      const normalized = normalizeTransportError(err, abortSignal);
      yield {
        type: "error",
        code: normalized.code,
        message: normalized.message,
      };
      return;
    }

    // Emit complete validated tool requests only (never partial / invalid JSON).
    const sortedIndexes = [...toolBuffers.keys()].sort((a, b) => a - b);
    for (const index of sortedIndexes) {
      const buf = toolBuffers.get(index)!;
      if (!buf.name) {
        yield {
          type: "error",
          code: "malformed_tool_args",
          message: `Tool call at index ${index} missing function name`,
        };
        continue;
      }
      const callId = buf.id || `tool-${index}`;
      let parsed: unknown;
      try {
        parsed = buf.arguments.trim() === "" ? {} : JSON.parse(buf.arguments);
      } catch {
        // Adapter-level: never emit tool_request for invalid JSON → never executed.
        yield {
          type: "error",
          code: "malformed_tool_args",
          message: `Malformed tool arguments for ${buf.name} (call ${callId})`,
        };
        continue;
      }
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        yield {
          type: "error",
          code: "malformed_tool_args",
          message: `Tool arguments for ${buf.name} must be a JSON object`,
        };
        continue;
      }
      yield {
        type: "tool_request",
        callId,
        name: buf.name,
        input: parsed as Record<string, unknown>,
      };
    }

    // Compatible endpoints may omit usage on stream; we emit usage only when present
    // (never invent token counts).
    yield { type: "completed", finishReason };
  }
}

function toOpenAIMessage(m: ProviderMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return {
      role: "tool",
      content: m.content,
      ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      ...(m.name ? { name: m.name } : {}),
    };
  }
  return { role: m.role, content: m.content };
}

function mapFinishReason(
  reason: string,
): "stop" | "tool_calls" | "length" | "error" {
  switch (reason) {
    case "stop":
      return "stop";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
      return "length";
    default:
      return "error";
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * Yield payload strings from `data:` lines of an SSE stream.
 */
async function* readSseDataLines(
  body: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (abortSignal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Normalize CRLF → LF for OpenAI-compatible SSE.
      buffer = buffer.replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLines: string[] = [];
        for (const line of rawEvent.split("\n")) {
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
        if (dataLines.length > 0) {
          yield dataLines.join("\n");
        }
      }
    }
    // Flush trailing data without final blank line.
    if (buffer.trim()) {
      const dataLines: string[] = [];
      for (const line of buffer.replace(/\r\n/g, "\n").split("\n")) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      if (dataLines.length > 0) {
        yield dataLines.join("\n");
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}
