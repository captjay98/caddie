import { useForm } from '@inertiajs/react';

export default function Home({ appName, tasks }) {
	const form = useForm({ title: '' });

	function submit(event) {
		event.preventDefault();
		form.post('/tasks', { onSuccess: () => form.reset() });
	}

	return (
		<main>
			<h1>{appName}</h1>
			<form onSubmit={submit}>
				<input
					value={form.data.title}
					onChange={(event) => form.setData('title', event.target.value)}
					placeholder="New task"
					aria-label="Task title"
				/>
				<button type="submit" disabled={form.processing}>
					Add
				</button>
			</form>
			{form.errors.title && (
				<p role="alert" data-testid="title-error">
					{form.errors.title}
				</p>
			)}
			<ul data-testid="task-list">
				{tasks.map((task) => (
					<li key={task.id} data-testid="task-item">
						{task.done ? 'done' : 'open'}: {task.title}
					</li>
				))}
			</ul>
		</main>
	);
}
