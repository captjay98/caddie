import { StrictMode, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemePicker } from '../../../apps/app/src/client/workspace/ThemePicker.tsx';
import {
	applyTheme,
	browserStorage,
	currentTheme,
	saveThemeChoice,
	type ThemeChoice,
} from '../../../apps/app/src/client/theme.ts';

/**
 * Test-only harness for tests/browser/theme-picker.spec.ts: mounts the REAL
 * ThemePicker (variant="panel") wired to the REAL theme.ts helpers through a
 * setThemeChoice that is a line-for-line mirror of the shell's own
 * (apps/app/src/client/workspace/Chrome.tsx setThemeChoice): it reads the live
 * <html> state, applyTheme()s the next choice onto <html>, and persists it
 * with saveThemeChoice(). No WorkspaceChrome provider is pulled in — the panel
 * is a pure component, and this keeps the harness to the real theme surface
 * under live click/keyboard, which is what the browser click-through proves.
 * The real API behaviour of the surrounding shell is covered elsewhere.
 */
function Harness(): ReactElement {
	const [choice, setChoice] = useState<ThemeChoice>(() => currentTheme());

	function setThemeChoice(patch: Partial<ThemeChoice>): void {
		const previous = currentTheme();
		const next: ThemeChoice = {
			palette: patch.palette ?? previous.palette,
			mode: patch.mode ?? previous.mode,
		};
		applyTheme(next);
		saveThemeChoice(browserStorage(), next, previous);
		setChoice(next);
	}

	return <ThemePicker variant="panel" palette={choice.palette} mode={choice.mode} onChange={setThemeChoice} />;
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<Harness />
	</StrictMode>,
);
