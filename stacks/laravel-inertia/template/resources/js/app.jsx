import { createInertiaApp } from '@inertiajs/react';
import { resolvePageComponent } from 'laravel-vite-plugin/inertia-helpers';
import { createRoot, hydrateRoot } from 'react-dom/client';

createInertiaApp({
	title: (title) => `${title} — Forge App`,
	resolve: (name) =>
		resolvePageComponent(`./Pages/${name}.jsx`, import.meta.glob('./Pages/**/*.jsx')),
	setup({ el, App, props }) {
		if (import.meta.env.SSR) {
			hydrateRoot(el, <App {...props} />);
		} else {
			createRoot(el).render(<App {...props} />);
		}
	},
	progress: { color: '#f0a83c' },
});
