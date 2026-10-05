import { createRootRoute, Outlet } from "@tanstack/react-router";

export function Root() {
	return (
		<html lang="en">
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>Forge App (TanStack Start)</title>
			</head>
			<body>
				<main>
					<Outlet />
				</main>
			</body>
		</html>
	);
}

export const Route = createRootRoute({ component: Root });
