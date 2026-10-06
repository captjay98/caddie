import { describe, expect, test } from "bun:test";
import { createApp, createTaskStore } from "./app";

describe("seeded task tracker", () => {
	test("health endpoint responds ok", async () => {
		const res = await createApp().request("/api/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	test("seeds two open tasks", async () => {
		const res = await createApp().request("/api/tasks");
		const body = (await res.json()) as { tasks: unknown[]; open: number };
		expect(body.tasks).toHaveLength(2);
		expect(body.open).toBe(2);
	});

	test("adding a task requires a non-empty title", async () => {
		const res = await createApp().request("/api/tasks", {
			method: "POST",
			body: JSON.stringify({ title: "  " }),
		});
		expect(res.status).toBe(400);
	});

	test("toggle flips completion", async () => {
		const app = createApp();
		const created = (await (await app.request("/api/tasks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "new" }),
		})).json()) as { task: { id: string } };
		const toggled = (await (await app.request(`/api/tasks/${created.task.id}/toggle`, {
			method: "POST",
		})).json()) as { task: { done: boolean } };
		expect(toggled.task.done).toBe(true);
	});
});
