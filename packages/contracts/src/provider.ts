import { z } from "zod";

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
    callId: z.string(),
    name: z.string(),
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
    code: z.string(),
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

export const ProviderRequestSchema = z.object({
  modelId: z.string(),
  messages: z.array(ProviderMessageSchema),
  tools: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        inputSchema: z.record(z.unknown()),
      }),
    )
    .optional(),
});
export type ProviderRequest = z.infer<typeof ProviderRequestSchema>;

/** Minimal provider interface every adapter must implement. */
export interface ModelProvider {
  readonly id: string;
  capabilities(): ProviderCapabilities;
  stream(
    request: ProviderRequest,
    abortSignal?: AbortSignal,
  ): AsyncIterable<StreamEvent>;
}
