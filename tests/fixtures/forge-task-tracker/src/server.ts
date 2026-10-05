import { createApp } from "./app";

const app = createApp();

export default {
	port: Number(process.env.PORT ?? 8787),
	fetch: app.fetch,
};
