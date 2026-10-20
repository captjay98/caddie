import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeAssistantText, cleanAssistantText } from "../apps/app/src/client/conversation/response-hygiene.ts";
import { capabilityReport, capabilitySignals } from "../apps/app/src/server/coordinator-context.ts";
import { runDryRun, loadCases } from "../scripts/evaluate-ai-behavior.ts";

/**
 * R04 LOCAL VERIFIED: response hygiene + capability honesty + the dry-run eval
 * harness, with NO model and NO network. Live model comparison is gated and
 * not run here (plan §5).
 */

describe("R04 response hygiene (text-part leakage)", () => {
  test("strips a <think> block but keeps the surrounding prose", () => {
    const r = sanitizeAssistantText("Here is your plan.<think>internal</think> Six features.");
    expect(r.stripped).toContain("reasoning-tag");
    expect(r.text).toBe("Here is your plan. Six features.");
  });

  test("strips an unclosed reasoning tag at a streaming tail", () => {
    const r = sanitizeAssistantText("Partial answer.<reasoning>still thinking about");
    expect(r.stripped).toContain("reasoning-tag-open");
    expect(r.text).toBe("Partial answer.");
  });

  test("strips a raw svg dump from prose", () => {
    const r = sanitizeAssistantText('Icon: <svg viewBox="0 0 1 1"><path d="M0 0"/></svg> ok');
    expect(r.stripped).toContain("raw-svg");
    expect(r.text).not.toContain("<svg");
  });

  test("drops a dangling serialization-fragment line", () => {
    const r = sanitizeAssistantText('Working.\n{"type":"text","text":""}\nDone.');
    expect(r.stripped).toContain("serialization-fragment");
    expect(r.text).toBe("Working.\nDone.");
  });

  test("the coordinator is told a proposal exists only when propose_project returned (live finding, 2026-10-20)", () => {
    // It wrote the proposal out as JSON instead, then insisted three times
    // that a card had been shown.
    const source = readFileSync(new URL("../apps/app/src/agents/coordinator.ts", import.meta.url), "utf8");
    for (const phrase of [
      "Make a proposal ONLY by calling propose_project",
      "never write its fields into your reply",
      "the person sees nothing until propose_project returns",
      "Mention the card only after propose_project has returned in this turn",
      "say the proposal did not go through",
    ]) {
      expect(source).toContain(phrase);
    }
  });

  test("never shows a project proposal written out as JSON instead of a card (live finding, 2026-10-20)", () => {
    // The coordinator printed propose_project's arguments as its reply, twice,
    // and no card appeared.
    const farmlog =
      '{"name": "FarmLog AI", "idea": "A daily logging app for Nigerian broiler and catfish farmers.", "brief": "FarmLog AI helps farmers log daily activities.", "hackathon": "Nebius x NVIDIA Global AI Hackathon", "track": "Personal AI Track"}';
    const r = sanitizeAssistantText(`${farmlog}\n\n${farmlog}`);
    expect(r.text).toBe("");
    expect(r.stripped).toContain("tool-arguments");
    // Fenced, pretty-printed, with prose around it: only the proposal goes.
    const pretty = JSON.stringify(JSON.parse(farmlog), null, 2);
    expect(cleanAssistantText(`Here it is:\n\`\`\`json\n${pretty}\n\`\`\`\nTell me what to change.`)).toBe("Here it is:\n\nTell me what to change.");
    expect(cleanAssistantText(`Here it is:\n\n${pretty}\n\nTell me what to change.`)).toBe("Here it is:\n\nTell me what to change.");
    // JSON the person asked for is left alone.
    const prices = '```json\n{"commodity": "catfish", "price_kobo": 250000}\n```';
    expect(cleanAssistantText(prices)).toBe(prices);
  });

  test("an all-placeholder chain becomes empty (render nothing)", () => {
    const r = sanitizeAssistantText("•  —  -  ·");
    expect(r.stripped).toContain("empty-placeholder");
    expect(r.text).toBe("");
  });

  test("clean prose is unchanged", () => {
    const r = sanitizeAssistantText("Your plan is ready: six features.");
    expect(r.changed).toBe(false);
    expect(cleanAssistantText("Your plan is ready: six features.")).toBe("Your plan is ready: six features.");
  });

  // Live-observed failure (2026-10-12): the model leaked its planning as PLAIN
  // PROSE with no <think> wrapper. These pin the untagged-leak stripper AND its
  // conservatism (a real answer saying "we need to" survives).
  test("strips the untagged planning-scratchpad prefix the model leaked", () => {
    const leak =
      "We need to find all open hackathons on Devpost and their prizes. We should call find_hackathons with query maybe empty? Let's call find_hackathons with limit 20. Here's what the live Devpost search returned right now.";
    const r = sanitizeAssistantText(leak);
    expect(r.stripped).toContain("planning-leak");
    expect(r.text).toBe("Here's what the live Devpost search returned right now.");
    expect(r.text).not.toContain("find_hackathons");
  });

  test("strips a multi-sentence tool-deliberation prefix, keeps the real reply", () => {
    const leak =
      "The user wants all open hackathons. We must call the tool and not invent listings. We'll parse the candidate ids from the json. Based on your profile, here are the live results.";
    const r = sanitizeAssistantText(leak);
    expect(r.stripped).toContain("planning-leak");
    expect(r.text).toBe("Based on your profile, here are the live results.");
  });

  test("does NOT strip legitimate prose that happens to say 'we need to'", () => {
    const real = "To enter this hackathon we need to register before June 6 and submit a demo video.";
    const r = sanitizeAssistantText(real);
    expect(r.stripped).not.toContain("planning-leak");
    expect(r.text).toBe(real);
  });

  test("does NOT strip a normal 'Let's' call-to-action to the user", () => {
    const real = "Let's start shaping a project idea that fits the DataHub Agent Hackathon theme.";
    const r = sanitizeAssistantText(real);
    expect(r.stripped).not.toContain("planning-leak");
    expect(r.text).toBe(real);
  });

  test("never strips the entire message on the planning rule alone", () => {
    // Every sentence looks like planning — the guard keeps the text rather than
    // blanking a reply the heuristic can't safely cut.
    const r = sanitizeAssistantText("We should call find_hackathons. We need to parse the json.");
    expect(r.stripped).not.toContain("planning-leak");
  });
});

describe("R04 capability honesty", () => {
  test("no sandbox config -> build-sandbox unavailable with a planning next action", () => {
    const report = capabilityReport(capabilitySignals({}));
    const build = report.find((c) => c.id === "build-sandbox")!;
    expect(build.enabled).toBe(false);
    expect(build.nextAction.toLowerCase()).toContain("planning");
  });

  test("sandbox configured -> build-sandbox enabled", () => {
    const report = capabilityReport(
      capabilitySignals({ CONTREE_BASE_URL: "x", CONTREE_API_TOKEN: "y", CONTREE_PROJECT_ID: "z" }),
    );
    expect(report.find((c) => c.id === "build-sandbox")!.enabled).toBe(true);
  });

  test("discovery+research enabled with a Tavily key (model must not claim it cannot search)", () => {
    const report = capabilityReport(capabilitySignals({ TAVILY_API_KEY: "tvly-test" }));
    expect(report.find((c) => c.id === "discovery")!.enabled).toBe(true);
    expect(report.find((c) => c.id === "research")!.enabled).toBe(true);
  });

  test("no Tavily key -> discovery+research honestly reported unavailable", () => {
    const report = capabilityReport(capabilitySignals({}));
    expect(report.find((c) => c.id === "discovery")!.enabled).toBe(false);
    expect(report.find((c) => c.id === "research")!.enabled).toBe(false);
    expect(report.find((c) => c.id === "research")!.nextAction.toLowerCase()).toContain("unavailable");
  });

  test("Stage 3: image understanding is enabled with a Nebius key (model must not claim it cannot see)", () => {
    const report = capabilityReport(capabilitySignals({ NEBIUS_API_KEY: "nb-test" }));
    const image = report.find((c) => c.id === "image-input")!;
    expect(image.enabled).toBe(true);
    expect(image.reason.toLowerCase()).toContain("vision");
  });

  test("Stage 3: no Nebius key -> image understanding honestly unavailable", () => {
    const report = capabilityReport(capabilitySignals({}));
    expect(report.find((c) => c.id === "image-input")!.enabled).toBe(false);
  });

  test("Stage 3: file input is on, with an honest PDF caveat", () => {
    const report = capabilityReport(capabilitySignals({}));
    const file = report.find((c) => c.id === "file-input")!;
    expect(file.enabled).toBe(true);
    expect(file.reason.toLowerCase()).toContain("pdf");
  });
});

describe("R04 dry-run eval harness", () => {
  test("all frozen deterministic cases pass with no model/network", () => {
    const { results, allPassed } = runDryRun();
    const failing = results.filter((r) => !r.passed).map((r) => `${r.id}: ${r.detail}`);
    expect(failing, failing.join("; ")).toHaveLength(0);
    expect(allPassed).toBe(true);
  });

  test("the case file freezes both deterministic and model behaviors", () => {
    const cases = loadCases();
    expect(cases.version).toBe("1");
    expect(cases.deterministic.length).toBeGreaterThanOrEqual(6);
    // Model cases are named but NOT run here — they carry no pass/fail.
    expect(cases.model.map((c) => c.id)).toContain("no-reasoning-leak");
  });

  test("live mode refuses without authorization (never fakes a model result)", () => {
    const proc = Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "..", "scripts", "evaluate-ai-behavior.ts"), "--live"],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, CADDIE_LIVE_AUTHORIZED: undefined, NEBIUS_API_KEY: undefined } },
    );
    const output = `${proc.stdout}${proc.stderr}`;
    expect(proc.exitCode).not.toBe(0);
    expect(output).toContain("BLOCKED");
    expect(output).not.toContain("PASS");
  });
});
