import { z } from "zod";

export const ToolEffectCategorySchema = z.enum([
  "read",
  "write",
  "external",
]);
export type ToolEffectCategory = z.infer<typeof ToolEffectCategorySchema>;

export const ToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
  effect: ToolEffectCategorySchema,
  timeoutMs: z.number().int().positive().default(30_000),
  outputLimitBytes: z.number().int().positive().default(256_000),
  requiredPermissions: z.array(z.string()).default([]),
  safeRetry: z.boolean().default(false),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
