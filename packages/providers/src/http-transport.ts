/**
 * Injectable HTTP surface for provider adapters.
 * Production uses global fetch; tests inject a mock — no real network.
 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpTransport {
  fetch: FetchLike;
}

export function defaultTransport(): HttpTransport {
  return { fetch: globalThis.fetch.bind(globalThis) };
}
