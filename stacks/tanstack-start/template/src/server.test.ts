import { describe, expect, test } from "bun:test";

// The seeded test the journey proves; the full-stack persistence gate
// (visits survive across requests) is exercised in the live window.
describe("tanstack start template", () => {
	test("router module loads without error", async () => {
		const mod = await import("./router");
		expect(mod.router).toBeDefined();
	});
});
