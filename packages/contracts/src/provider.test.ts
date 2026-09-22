import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PROVIDER_ERROR_CODES,
  ProviderCapabilitiesSchema,
  ProviderRequestSchema,
  StreamEventSchema,
  isModelProvider,
  isProviderErrorCode,
  type ModelProvider,
} from "./provider.js";

describe("provider adapter contract", () => {
  it("exports canonical error codes used by adapters", () => {
    for (const code of [
      "aborted",
      "auth",
      "rate_limit",
      "timeout",
      "capability",
      "malformed_tool_args",
    ] as const) {
      assert.equal(isProviderErrorCode(code), true);
      assert.ok(PROVIDER_ERROR_CODES.includes(code));
    }
    assert.equal(isProviderErrorCode("not-a-code"), false);
  });

  it("validates StreamEvent shapes including tool_request and error", () => {
    assert.ok(
      StreamEventSchema.parse({
        type: "tool_request",
        callId: "c1",
        name: "read_file",
        input: { path: "a.ts" },
      }),
    );
    assert.ok(
      StreamEventSchema.parse({
        type: "error",
        code: "auth",
        message: "no",
      }),
    );
    assert.ok(
      StreamEventSchema.parse({
        type: "usage",
        inputTokens: 1,
        outputTokens: 2,
      }),
    );
    assert.throws(() =>
      StreamEventSchema.parse({
        type: "tool_request",
        callId: "",
        name: "x",
        input: {},
      }),
    );
  });

  it("validates ProviderRequest and capabilities", () => {
    const req = ProviderRequestSchema.parse({
      modelId: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "read_file",
          description: "r",
          inputSchema: { type: "object" },
        },
      ],
    });
    assert.equal(req.modelId, "m");
    const caps = ProviderCapabilitiesSchema.parse({
      nativeTools: true,
      structuredOutput: false,
      streaming: true,
    });
    assert.equal(caps.reasoningControls, false);
  });

  it("isModelProvider accepts duck-typed adapters", () => {
    const fake: ModelProvider = {
      id: "x",
      capabilities: () => ({
        nativeTools: true,
        structuredOutput: false,
        streaming: true,
        reasoningControls: false,
      }),
      async *stream() {
        yield { type: "completed", finishReason: "stop" };
      },
    };
    assert.equal(isModelProvider(fake), true);
    assert.equal(isModelProvider({}), false);
    assert.equal(isModelProvider(null), false);
  });
});
