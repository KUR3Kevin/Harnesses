import { z } from "zod";

/**
 * # Provider adapter contract (W06+)
 *
 * Single source of truth for every model adapter — FakeProvider, mocked
 * OpenAI-compatible, and any future live provider.
 *
 * ## Required surface (`ModelProvider`)
 * - `id` — stable adapter identifier (not a secret).
 * - `capabilities()` — declare native tools / streaming / etc. before use.
 * - `stream(request, abortSignal?)` — yield normalized `StreamEvent`s only.
 *
 * ## StreamEvent rules (adapters MUST)
 * 1. Emit `text_delta` for visible assistant text only (incremental OK).
 * 2. Emit `tool_request` **only** when name + `input` are complete and
 *    `input` is a validated JSON object. Buffer partial tool-call JSON;
 *    never emit partial args; never treat raw text as an executable command.
 * 3. Emit `usage` only from provider-reported totals (normalize field names;
 *    do **not** invent zeros when usage is unknown).
 * 4. End a successful turn with exactly one `completed` (unless a terminal
 *    `error` already ended the stream).
 * 5. On failure, emit `error` with a **canonical** `code` from
 *    `PROVIDER_ERROR_CODES` when applicable, and a redacted `message`
 *    (no API keys, bearer tokens, or Authorization headers).
 * 6. Honor `AbortSignal`: stop promptly; prefer `code: "aborted"`.
 *
 * ## Transport
 * Network I/O is an adapter concern. Live adapters SHOULD accept an injectable
 * HTTP transport/fetch so conformance tests never require real network.
 * Offline adapters (FakeProvider) need no transport.
 *
 * ## Non-goals of this contract
 * - Vendor wire formats (OpenAI SSE vs Anthropic events) — adapter-private.
 * - Tool execution, policy, or workspace I/O — runtime / worker packages.
 * - Credential storage — host/editor concern; keys must not appear in events.
 */

/** Canonical StreamEvent.error.code values (A20-oriented). */
export const PROVIDER_ERROR_CODES = [
  "aborted",
  "auth",
  "rate_limit",
  "timeout",
  "capability",
  "network",
  "provider_http",
  "provider_error",
  "malformed_tool_args",
  "malformed_sse",
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export const ProviderErrorCodeSchema = z.enum(PROVIDER_ERROR_CODES);

export const ProviderCapabilitiesSchema = z.object({
  nativeTools: z.boolean(),
  structuredOutput: z.boolean(),
  streaming: z.boolean(),
  maxInputTokens: z.number().int().positive().optional(),
  reasoningControls: z.boolean().default(false),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const StreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text_delta"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool_request"),
    callId: z.string().min(1),
    name: z.string().min(1),
    /** Complete tool arguments object — never partial JSON text. */
    input: z.record(z.unknown()),
  }),
  z.object({
    type: z.literal("usage"),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("completed"),
    finishReason: z.enum(["stop", "tool_calls", "length", "error"]),
  }),
  z.object({
    type: z.literal("error"),
    /** Prefer a canonical ProviderErrorCode; string kept for forward-compat. */
    code: z.string().min(1),
    message: z.string(),
  }),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

export const ProviderMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  toolCallId: z.string().optional(),
  name: z.string().optional(),
});
export type ProviderMessage = z.infer<typeof ProviderMessageSchema>;

export const ProviderToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
});
export type ProviderToolDefinition = z.infer<typeof ProviderToolDefinitionSchema>;

export const ProviderRequestSchema = z.object({
  modelId: z.string().min(1),
  messages: z.array(ProviderMessageSchema),
  tools: z.array(ProviderToolDefinitionSchema).optional(),
});
export type ProviderRequest = z.infer<typeof ProviderRequestSchema>;

/**
 * Explicit interface every adapter must implement.
 * FakeProvider and OpenAICompatibleProvider are reference implementations.
 */
export interface ModelProvider {
  readonly id: string;
  capabilities(): ProviderCapabilities;
  stream(
    request: ProviderRequest,
    abortSignal?: AbortSignal,
  ): AsyncIterable<StreamEvent>;
}

/** Runtime type guard for duck-typed providers (tests / DIY adapters). */
export function isModelProvider(value: unknown): value is ModelProvider {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.capabilities === "function" &&
    typeof v.stream === "function"
  );
}

/** True when code is one of the canonical provider error codes. */
export function isProviderErrorCode(code: string): code is ProviderErrorCode {
  return (PROVIDER_ERROR_CODES as readonly string[]).includes(code);
}
