import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "./api";

const API_BASE: string = import.meta.env.VITE_API_BASE ?? "";

interface Task {
	id: number;
	title: string;
	done: boolean;
}

export default function App() {
	const [tasks, setTasks] = useState<Task[]>([]);
	const [state, setState] = useState<"loading" | "ready" | "error">("loading");
	const [title, setTitle] = useState("");

	const refresh = useCallback(async () => {
		setState("loading");
		try {
			const res = await fetch(apiUrl(API_BASE, "/api/tasks"));
			if (!res.ok) throw new Error(`API answered ${res.status}`);
			setTasks((await res.json()) as Task[]);
			setState("ready");
		} catch {
			setState("error");
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	async function addTask(event: FormEvent) {
		event.preventDefault();
		const res = await fetch(apiUrl(API_BASE, "/api/tasks"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title }),
		});
		if (!res.ok) return;
		setTitle("");
		await refresh();
	}

	return (
		<main>
			<h1>Forge App</h1>
			{state === "loading" && <p role="status">loading…</p>}
			{state === "error" && (
				<p role="alert">
					API unreachable.{" "}
					<button type="button" onClick={() => void refresh()}>
						retry
					</button>
				</p>
			)}
			{state === "ready" && (
				<>
					<form onSubmit={addTask}>
						<input
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							placeholder="New task"
							aria-label="Task title"
						/>
						<button type="submit">Add</button>
					</form>
					<ul data-testid="task-list">
						{tasks.map((task) => (
							<li key={task.id} data-testid="task-item">
								{task.done ? "done" : "open"}: {task.title}
							</li>
						))}
					</ul>
				</>
			)}
		</main>
	);
}
