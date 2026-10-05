/**
 * Forge task tracker fixture — the seeded app for the P09 journey.
 *
 * Small and honest: an in-memory task store, a Hono API, a handful of tests
 * that pass as seeded (so the journey's "deliberate red" phase has a real,
 * machine-checkable baseline to break and repair).
 */
import { Hono } from "hono";

export interface Task {
	id: string;
	title: string;
	done: boolean;
}

export function createTaskStore() {
	const tasks = new Map<string, Task>();
	let nextId = 1;
	return {
		list(): Task[] {
			return [...tasks.values()].sort((a, b) => a.id.localeCompare(b.id));
		},
		add(title: string): Task {
			const task: Task = { id: `t${nextId++}`, title, done: false };
			tasks.set(task.id, task);
			return task;
		},
		toggle(id: string): Task | null {
			const task = tasks.get(id);
			if (!task) return null;
			task.done = !task.done;
			return task;
		},
		countOpen(): number {
			return [...tasks.values()].filter((t) => !t.done).length;
		},
	};
}

export function createApp() {
	const store = createTaskStore();
	store.add("seeded task one");
	store.add("seeded task two");
	const app = new Hono();
	app.get("/api/health", (c) => c.json({ ok: true }));
	app.get("/api/tasks", (c) => c.json({ tasks: store.list(), open: store.countOpen() }));
	app.post("/api/tasks", async (c) => {
		let body: { title?: string };
		try {
			body = (await c.req.json()) as { title?: string };
		} catch {
			return c.json({ error: "invalid_json" }, 400);
		}
		if (!body.title || body.title.trim() === "") {
			return c.json({ error: "title_required" }, 400);
		}
		return c.json({ task: store.add(body.title.trim()) }, 201);
	});
	app.post("/api/tasks/:id/toggle", (c) => {
		const task = store.toggle(c.req.param("id"));
		if (!task) return c.json({ error: "not_found" }, 404);
		return c.json({ task });
	});
	return app;
}
