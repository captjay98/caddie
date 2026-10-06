import { describe, expect, test } from "bun:test";
import { apiUrl } from "./api";

describe("api url helper", () => {
	test("joins the configured base with the endpoint path without stray slashes", () => {
		expect(apiUrl("http://127.0.0.1:9000", "/api/health")).toBe(
			"http://127.0.0.1:9000/api/health",
		);
		expect(apiUrl("", "/api/tasks")).toBe("/api/tasks");
		expect(apiUrl("http://127.0.0.1:9000/", "/api/tasks")).toBe(
			"http://127.0.0.1:9000/api/tasks",
		);
	});
});
