import { describe, expect, test } from "bun:test";
import { createFlueClient } from "@flue/sdk";

/** LIVE smoke test only. Restart and full build acceptance require separate
 * evidence. An authorization flag alone can never count as a model pass. */
describe("live authenticated coordinator round-trip", () => {
  test("a real provider response settles and survives a fresh history read", async () => {
    const url = process.env.CADDIE_LIVE_CONVERSATION_URL;
    const cookie = process.env.CADDIE_LIVE_SESSION_COOKIE;
    if (process.env.CADDIE_LIVE_AUTHORIZED !== "1" || !url || !cookie) {
      throw new Error(
        "BLOCKED: requires explicit CADDIE_LIVE_AUTHORIZED=1, CADDIE_LIVE_CONVERSATION_URL and CADDIE_LIVE_SESSION_COOKIE. This test makes a paid model call; no mocked evidence is accepted.",
      );
    }
    const client = createFlueClient({ url, headers: { cookie } });
    const admitted = await client.send({
      message: {
        kind: "user",
        body: "Briefly introduce yourself and explain how you help with hackathons. Do not create a project or execute sandbox work.",
      },
      idempotencyKey: `live-smoke:${crypto.randomUUID()}`,
    });
    const reply = await client.read(admitted);
    expect(reply.text.trim().length).toBeGreaterThan(0);
    const history = await createFlueClient({
      url,
      headers: { cookie },
    }).history();
    expect(
      history.settlements.some(
        (item) =>
          item.submissionId === admitted.submissionId &&
          item.outcome === "completed",
      ),
    ).toBe(true);
  }, 180_000);
});
