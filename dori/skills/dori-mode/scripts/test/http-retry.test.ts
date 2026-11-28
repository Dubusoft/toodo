import { expect, test } from "bun:test";

import { fetchHttp, HTTP_TIMEOUT_MS } from "../src/messenger/http.ts";

test("fetchHttp uses a default 30-second timeout signal", async () => {
  const originalFetch = globalThis.fetch;
  let receivedSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    receivedSignal = init?.signal;
    return new Response("ok");
  }) as typeof fetch;
  try {
    await fetchHttp({ method: "GET", url: "https://example.test" });
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(HTTP_TIMEOUT_MS).toBe(30_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
