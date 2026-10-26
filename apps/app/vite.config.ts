import { cloudflare } from "@cloudflare/vite-plugin";
import { flue, flueWorkerConfig } from "@flue/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Prebundle the patched SDK and its React consumer together. This also
  // invalidates stale dev bundles after the checkpoint-resume patch changed.
  optimizeDeps: { include: ["@flue/sdk", "@flue/react"] },
  // Flue discovers the Worker entry dynamically. Prebundle its complete server
  // import graph before entrypoint inspection; late discoveries otherwise
  // replace chunks while Workerd is still importing their previous names.
  environments: { caddie_app: { optimizeDeps: { include: [
    '@flue/runtime', '@flue/runtime/cloudflare', '@flue/runtime/routing',
    '@flue/runtime/internal', '@flue/runtime/cloudflare/internal',
    '@flue/runtime/cloudflare/workers-ai', '@earendil-works/pi-ai',
    '@earendil-works/pi-ai/api/openai-completions.lazy',
    'better-auth', 'better-auth/plugins', 'hono',
  ] } } },
  plugins: [
    flue(),
    react(),
    cloudflare({
      config: flueWorkerConfig(),
      // Tests isolate local workerd state from the user's running dev database.
      persistState: process.env.CADDIE_TEST_STATE
        ? { path: process.env.CADDIE_TEST_STATE }
        : true,
    }),
  ],
  // The dev server is PINNED to 5176: 5173-5175 belong to other local
  // projects, and the OAuth redirect URIs are registered for 5176
  // (docs/setup/auth.md). strictPort fails loudly instead of drifting
  // onto an unregistered port.
  server: { port: 5176, host: "localhost", strictPort: true },
});
