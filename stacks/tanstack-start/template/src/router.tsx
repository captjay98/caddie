import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

// The Start vite plugin generates src/routeTree.gen.ts from src/routes/ at
// build/dev time and binds both client and server entries to this factory.
export function getRouter() {
	return createRouter({ routeTree });
}
