import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// P00 scaffold: proves the React client composes into the Worker assets
// under /app. The workspace shell, TanStack Router/Query and @flue/react
// transport arrive in P06.
function App() {
	return (
		<main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
			<h1>Caddie</h1>
			<p>Workspace scaffold — product UI lands in P06.</p>
		</main>
	);
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
