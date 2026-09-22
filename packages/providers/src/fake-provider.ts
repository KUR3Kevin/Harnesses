import type {
  ModelProvider,
  ProviderCapabilities,
  ProviderRequest,
  StreamEvent,
} from "@kur3/contracts";

export type FakeScenario =
  | "greet"
  | "edit_hello"
  | "plan_only"
  | "malformed_tool"
  | "empty";

export interface FakeProviderOptions {
  scenario?: FakeScenario;
  /** Deterministic tool call id prefix for tests. */
  callIdPrefix?: string;
}

/**
 * Deterministic offline provider. No network. No API keys.
 * Scenario selection drives a fixed tool/edit script for demos and tests.
 */
export class FakeProvider implements ModelProvider {
  readonly id = "fake";
  private readonly scenario: FakeScenario;
  private readonly callIdPrefix: string;
  private turn = 0;

  constructor(options: FakeProviderOptions = {}) {
    this.scenario = options.scenario ?? "edit_hello";
    this.callIdPrefix = options.callIdPrefix ?? "fake-call";
  }

  capabilities(): ProviderCapabilities {
    return {
      nativeTools: true,
      structuredOutput: false,
      streaming: true,
      maxInputTokens: 8_000,
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

    this.turn += 1;
    const last = request.messages[request.messages.length - 1];
    const hasToolResult =
      last?.role === "tool" ||
      request.messages.some((m) => m.role === "tool");

    if (this.scenario === "empty") {
      yield { type: "text_delta", text: "" };
      yield { type: "completed", finishReason: "stop" };
      return;
    }

    if (this.scenario === "greet") {
      yield {
        type: "text_delta",
        text: "Hello from the fake provider (offline).",
      };
      yield {
        type: "usage",
        inputTokens: 12,
        outputTokens: 8,
      };
      yield { type: "completed", finishReason: "stop" };
      return;
    }

    if (this.scenario === "malformed_tool" && this.turn === 1) {
      // Emit a complete but intentionally invalid tool name for policy tests.
      yield {
        type: "tool_request",
        callId: `${this.callIdPrefix}-bad`,
        name: "not_a_real_tool",
        input: { path: "../etc/passwd" },
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }

    if (this.scenario === "plan_only") {
      yield {
        type: "text_delta",
        text: "Plan: read src/hello.ts, then propose a patch. Not applying.",
      };
      yield {
        type: "tool_request",
        callId: `${this.callIdPrefix}-1`,
        name: "read_file",
        input: { path: "src/hello.ts" },
      };
      if (hasToolResult) {
        yield {
          type: "tool_request",
          callId: `${this.callIdPrefix}-2`,
          name: "propose_patch",
          input: {
            path: "src/hello.ts",
            expectedHash: "ignored-in-plan",
            newContent:
              'export function hello(): string {\n  return "hello, kur3";\n}\n',
          },
        };
        yield {
          type: "text_delta",
          text: "\nProposed change ready for review (plan mode).",
        };
        yield { type: "completed", finishReason: "stop" };
        return;
      }
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }

    // Default: edit_hello — read, patch, done
    if (!hasToolResult && this.turn === 1) {
      yield {
        type: "text_delta",
        text: "I will read the fixture and apply a small edit.",
      };
      yield {
        type: "tool_request",
        callId: `${this.callIdPrefix}-1`,
        name: "read_file",
        input: { path: "src/hello.ts" },
      };
      yield {
        type: "usage",
        inputTokens: 40,
        outputTokens: 20,
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }

    const denied = request.messages.some(
      (m) =>
        m.role === "tool" &&
        typeof m.content === "string" &&
        m.content.includes('"status":"denied"'),
    );
    if (denied) {
      yield {
        type: "text_delta",
        text: "Stopping: tool request was denied by policy.",
      };
      yield { type: "completed", finishReason: "stop" };
      return;
    }

    const applied = request.messages.some(
      (m) =>
        m.role === "tool" &&
        typeof m.content === "string" &&
        m.content.includes('"status":"applied"'),
    );

    if (hasToolResult && !applied) {
      // After read: apply patch. Hash is filled by runtime if possible;
      // fake provider uses placeholder that worker will validate via expected flow.
      const readMsg = [...request.messages]
        .reverse()
        .find((m) => m.role === "tool" && m.name === "read_file");
      let expectedHash = "unknown";
      let currentContent =
        'export function hello(): string {\n  return "hello";\n}\n';
      if (readMsg?.content) {
        try {
          const parsed = JSON.parse(readMsg.content) as {
            hash?: string;
            content?: string;
          };
          if (parsed.hash) expectedHash = parsed.hash;
          if (parsed.content) currentContent = parsed.content;
        } catch {
          // keep defaults
        }
      }
      const newContent = currentContent.includes("hello, kur3")
        ? currentContent
        : currentContent.replace('"hello"', '"hello, kur3"');

      yield {
        type: "tool_request",
        callId: `${this.callIdPrefix}-2`,
        name: "apply_patch",
        input: {
          path: "src/hello.ts",
          expectedHash,
          newContent,
        },
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }

    yield {
      type: "text_delta",
      text: "Edit complete. Fixture should greet kur3.",
    };
    yield {
      type: "usage",
      inputTokens: 80,
      outputTokens: 30,
    };
    yield { type: "completed", finishReason: "stop" };
  }
}
