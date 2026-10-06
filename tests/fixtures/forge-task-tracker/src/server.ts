/**
 * Forge task tracker server — serves the Hono API from ./app plus the built
 * React client (public/index.html + dist/main.js) so the journey's browser
 * phase exercises the real UI against the real API.
 */
import { serveStatic } from "hono/bun";
import { createApp } from "./app";

const app = createApp();

// Built client bundle (bun build src/main.tsx --outdir dist) and the page
// that mounts it. API routes registered in createApp() take precedence.
app.use("/dist/*", serveStatic({ root: "./" }));
app.get("/", serveStatic({ root: "./public", rewriteRequestPath: () => "/index.html" }));

export default {
	port: Number(process.env.PORT ?? 8787),
	fetch: app.fetch,
};
