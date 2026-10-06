import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Route as RootRoute } from "./routes/__root";
import { Route as IndexRoute, RouteComponent } from "./routes/index";

// The seeded test the journey proves: route modules load and the index route
// renders server-side without a browser. The full router (src/router.tsx)
// needs the vite plugin's generated routeTree.gen, produced by `bun run
// build`; the production-start gate (server state across requests) is
// exercised by the live spec.
describe("tanstack start template", () => {
	test("route modules declare their components", () => {
		expect(typeof RootRoute.options.component).toBe("function");
		expect(typeof IndexRoute.options.component).toBe("function");
	});

	test("the index route renders server-side without a browser", () => {
		const html = renderToStaticMarkup(<RouteComponent />);
		expect(html).toContain("Forge App");
		expect(html).toContain("server says: rendered");
	});
});
