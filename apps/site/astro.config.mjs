import { defineConfig } from 'astro/config';

// Static output only: the landing is composed into the Worker's assets tree
// by scripts/compose-assets.ts. No second application server.
export default defineConfig({
	output: 'static',
});
