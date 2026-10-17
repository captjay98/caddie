// A generated-app stand-in for the preview runtime tests: React-free, but the
// same server shape the react-hono template gives every app (Hono, basePath
// /api, plain D1 API on env.DB).
import { Hono } from 'hono';

interface D1Like {
	prepare(sql: string): {
		bind(...values: unknown[]): { run(): Promise<{ meta: { last_row_id: number } }> };
		all(): Promise<{ results: unknown[] }>;
	};
}

type Env = { DB: D1Like; WEATHER_KEY?: string };

const app = new Hono<{ Bindings: Env }>().basePath('/api');

app.get('/health', (c) => c.json({ ok: true }));

app.get('/notes', async (c) => {
	const { results } = await c.env.DB.prepare('select id, body from notes order by id').all();
	return c.json(results);
});

app.post('/notes', async (c) => {
	const { body } = await c.req.json<{ body: string }>();
	const result = await c.env.DB.prepare('insert into notes (body) values (?)').bind(body).run();
	return c.json({ id: result.meta.last_row_id }, 201);
});

app.get('/key', (c) => c.json({ key: c.env.WEATHER_KEY ?? null }));

app.get('/egress', async (c) => {
	try {
		await fetch('https://example.com/');
		return c.text('allowed');
	} catch {
		return c.text('blocked');
	}
});

app.get('/cookie', (c) => {
	c.header('set-cookie', 'sid=abc; Path=/; HttpOnly', { append: true });
	c.header('set-cookie', 'theme=dark; Path=/', { append: true });
	return c.json({ ok: true });
});

export default app;
