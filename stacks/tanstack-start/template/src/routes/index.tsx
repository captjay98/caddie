import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

// Server function: state persists across requests (the full-stack behavior
// the P15a gate proves). A module-level counter is a demonstration of the
// server boundary, not the app's real storage.
let visits = 0;

const getVisits = createServerFn({ method: "GET" }).handler(() => {
	visits += 1;
	return { visits };
});

export function RouteComponent() {
	return (
		<div id="app">
			<h1>Forge App</h1>
			<p data-testid="server-state">server says: rendered</p>
			<form method="post">
				<button type="button" data-testid="ping-server" onClick={() => void getVisits()}>
					ping
				</button>
			</form>
		</div>
	);
}

export const Route = createFileRoute("/")({ component: RouteComponent });
