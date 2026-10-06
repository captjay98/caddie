import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev server proxies /api to the FastAPI service so the client always
// talks same-origin /api; production either deploys both behind one origin
// or bakes the API origin in with VITE_API_BASE (plus the explicit
// CADDIE_CLIENT_ORIGIN allowlist on the service).
export default defineConfig({
	plugins: [react()],
	server: {
		proxy: { "/api": "http://127.0.0.1:8080" },
	},
});
