/**
 * Forge task tracker client — the React entry the seeded build compiles
 * (`bun build src/main.tsx --outdir dist --target browser --minify`).
 *
 * Renders the persisted task list from the Hono API. Kept deliberately
 * small: the journey's browser phase asserts THIS component shows the
 * seeded data in a real browser.
 */
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

interface Task {
	id: string;
	title: string;
	done: boolean;
}

function App() {
	const [tasks, setTasks] = useState<Task[] | null>(null);
	const [open, setOpen] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [title, setTitle] = useState("");

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/tasks");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as { tasks: Task[]; open: number };
			setTasks(body.tasks);
			setOpen(body.open);
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const addTask = useCallback(async () => {
		const trimmed = title.trim();
		if (trimmed === "") return;
		const res = await fetch("/api/tasks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: trimmed }),
		});
		if (res.ok) {
			setTitle("");
			await refresh();
		}
	}, [title, refresh]);

	if (error) return <p role="alert">failed to load tasks: {error}</p>;
	if (tasks === null) return <p role="status">loading…</p>;

	return (
		<section>
			<p data-testid="open-count">{open} open</p>
			<ul data-testid="task-list">
				{tasks.map((task) => (
					<li key={task.id} data-testid="task-item" data-task-id={task.id} data-done={task.done}>
						{task.title}
					</li>
				))}
			</ul>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void addTask();
				}}
			>
				<input
					aria-label="task title"
					value={title}
					onInput={(event) => setTitle(event.currentTarget.value)}
				/>
				<button type="submit">add</button>
			</form>
		</section>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<App />);
}
