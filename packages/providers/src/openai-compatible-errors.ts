/**
 * Normalize OpenAI-compatible HTTP / transport failures into distinct codes.
 * Codes come from @kur3/contracts (single source of truth).
 * Never include Authorization / apiKey values in messages.
 */
import type { ProviderErrorCode } from "@kur3/contracts";

export type { ProviderErrorCode };

export interface NormalizedProviderError {
  code: ProviderErrorCode;
  message: string;
}

const SECRET_PATTERNS = [
  /Bearer\s+[^\s]+/gi,
  /sk-[A-Za-z0-9_-]+/g,
  /api[_-]?key["\s:=]+[^\s"',}]+/gi,
];

/** Strip likely secrets from any string that might reach logs or StreamEvent.error. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

export function normalizeHttpError(
  status: number,
  bodyText: string,
): NormalizedProviderError {
  const safe = redactSecrets(bodyText).slice(0, 500);
  if (status === 401 || status === 403) {
    return {
      code: "auth",
      message: `Authentication failed (HTTP ${status})${safe ? `: ${safe}` : ""}`,
    };
  }
  if (status === 429) {
    return {
      code: "rate_limit",
      message: `Rate limited (HTTP 429)${safe ? `: ${safe}` : ""}`,
    };
  }
  if (status === 408 || status === 504) {
    return {
      code: "timeout",
      message: `Request timed out (HTTP ${status})${safe ? `: ${safe}` : ""}`,
    };
  }
  if (status === 400 || status === 404 || status === 422) {
    const lower = safe.toLowerCase();
    if (
      lower.includes("model") ||
      lower.includes("tool") ||
      lower.includes("unsupported") ||
      lower.includes("not found") ||
      lower.includes("does not support")
    ) {
      return {
        code: "capability",
        message: `Unsupported capability or request (HTTP ${status}): ${safe}`,
      };
    }
  }
  return {
    code: "provider_http",
    message: `Provider HTTP ${status}${safe ? `: ${safe}` : ""}`,
  };
}

export function normalizeTransportError(
  err: unknown,
  abortSignal?: AbortSignal,
): NormalizedProviderError {
  if (abortSignal?.aborted) {
    return { code: "aborted", message: "Request aborted" };
  }
  if (err && typeof err === "object") {
    const name = "name" in err ? String((err as { name?: unknown }).name) : "";
    const message =
      "message" in err
        ? redactSecrets(String((err as { message?: unknown }).message))
        : "Unknown transport error";
    if (name === "AbortError" || /aborted/i.test(message)) {
      return { code: "aborted", message: "Request aborted" };
    }
    if (
      name === "TimeoutError" ||
      /timeout/i.test(message) ||
      /timed out/i.test(message)
    ) {
      return { code: "timeout", message: `Request timed out: ${message}` };
    }
    if (
      name === "TypeError" ||
      /fetch failed/i.test(message) ||
      /network/i.test(message) ||
      /ECONNREFUSED/i.test(message) ||
      /ENOTFOUND/i.test(message)
    ) {
      return { code: "network", message: `Network error: ${message}` };
    }
    return { code: "provider_error", message };
  }
  return {
    code: "provider_error",
    message: redactSecrets(String(err)),
  };
}
