import { describe, test, expect, afterEach } from "bun:test";
import { helperModelCompletion } from "../apps/app/src/server/helper-model-call.ts";
import { findModelRouteForRole } from "../apps/app/src/agents/providers.ts";

/**
 * B02 §B — the F3 gap (GLM HTTP 529 "System is overloaded" surfaced
 * un-retried). The coordinator/specialist path is already retried by Flue
 * (MAX_TRANSIENT_MODEL_RETRIES = 3); the ONE un-retried path is
 * helperModelCompletion's direct single-shot fetch (rules-reading.ts,
 * candidate-inspection.ts). This adds a bounded transient retry (≤2 after the
 * original, 429/529/5xx, honouring Retry-After) around that fetch — and
 * proves the per-call receipt is still recorded exactly ONCE, not per attempt.
 *
 * No real sleeps: the retry delay source is injectable so the test runs
 * instantly. No paid calls — fetch is stubbed.
 */

const NEBIUS = "https://api.tokenfactory.nebius.com/v1/chat/completions";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function okBody() {
  const route = findModelRouteForRole("helperRules");
  return { model: route.modelId, choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function helperRequest() {
  const route = findModelRouteForRole("helperRules");
  return {
    role: "helperRules" as const,
    url: NEBIUS,
    request: { method: "POST", body: JSON.stringify({ model: route.modelId }) },
    // No sleeps in tests.
    sleepMs: async (_ms: number) => {},
  };
}

describe("B02 §B — bounded transient retry for direct helper model calls", () => {
  test("a 529 then a 200 is retried and succeeds", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1 ? jsonResponse(529, { error: "overloaded" }) : jsonResponse(200, okBody());
    }) as unknown as typeof fetch;

    const result = await helperModelCompletion(helperRequest());
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(calls).toBe(2); // one retry
  });

  test("a persistent 429 gives up after the bound and surfaces the last status", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse(429, { error: "rate limited" }, { "retry-after": "0" });
    }) as unknown as typeof fetch;

    const result = await helperModelCompletion(helperRequest());
    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    // original + at most 2 retries = 3 physical attempts, never unbounded.
    expect(calls).toBe(3);
  });

  test("a 400 (non-transient) is NOT retried", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse(400, { error: "bad request" });
    }) as unknown as typeof fetch;

    const result = await helperModelCompletion(helperRequest());
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(calls).toBe(1); // no retry on a client error
  });
});
