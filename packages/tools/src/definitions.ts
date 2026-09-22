import type { ToolDefinition } from "@kur3/contracts";

export const READ_FILE: ToolDefinition = {
  name: "read_file",
  description: "Read a UTF-8 text file inside the workspace root.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  effect: "read",
  timeoutMs: 10_000,
  outputLimitBytes: 256_000,
  requiredPermissions: ["workspace:read"],
  safeRetry: true,
};

export const SEARCH_FILES: ToolDefinition = {
  name: "search_files",
  description: "Search for a substring under a workspace subdirectory.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      under: { type: "string" },
    },
    required: ["pattern"],
  },
  effect: "read",
  timeoutMs: 30_000,
  outputLimitBytes: 256_000,
  requiredPermissions: ["workspace:read"],
  safeRetry: true,
};

export const PROPOSE_PATCH: ToolDefinition = {
  name: "propose_patch",
  description:
    "Propose a full-file replacement without writing. Requires expectedHash.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      expectedHash: { type: "string" },
      newContent: { type: "string" },
    },
    required: ["path", "expectedHash", "newContent"],
  },
  effect: "write",
  timeoutMs: 10_000,
  outputLimitBytes: 256_000,
  requiredPermissions: ["workspace:propose"],
  safeRetry: true,
};

export const APPLY_PATCH: ToolDefinition = {
  name: "apply_patch",
  description:
    "Apply a full-file replacement if expectedHash matches current content.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      expectedHash: { type: "string" },
      newContent: { type: "string" },
    },
    required: ["path", "expectedHash", "newContent"],
  },
  effect: "write",
  timeoutMs: 10_000,
  outputLimitBytes: 256_000,
  requiredPermissions: ["workspace:write"],
  safeRetry: false,
};

export const FIRST_TOOLS: ToolDefinition[] = [
  READ_FILE,
  SEARCH_FILES,
  PROPOSE_PATCH,
  APPLY_PATCH,
];

export function toolRegistry(
  extras: ToolDefinition[] = [],
): Map<string, ToolDefinition> {
  return new Map([...FIRST_TOOLS, ...extras].map((t) => [t.name, t]));
}
