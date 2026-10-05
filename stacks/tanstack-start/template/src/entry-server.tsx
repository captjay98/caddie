import { renderToPipeableStream } from "@tanstack/react-start/server";
import { createRouter } from "@tanstack/react-router";
import { Route as rootRoute } from "./routes/__root";
import { Route as indexRoute } from "./routes/index";

const routeTree = rootRoute.addChildren([indexRoute]);

export function fetchImpl(request: Request, response: import("node:http").ServerResponse) {
	const router = createRouter({ routeTree });
	return renderToPipeableStream({ router, request, response });
}
