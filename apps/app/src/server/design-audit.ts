import { lookThemeBlock, type LooksSet } from '@caddie/contracts';
import { approvedAppearanceDocuments } from './visual-fidelity.ts';
import { configuredBrowserChecks, type BrowserCheckEnv } from './browser-check-service.ts';
import type { MachineFinding } from './artifact-quality.ts';

/** What the private browser service measured on one rendered screen at one size. */
export interface DesignAuditResult {
	stateId: string;
	viewport: 'phone' | 'desktop';
	contrast: string[];
	targets: string[];
	overflow: boolean;
}
export interface DesignAuditPort {
	audit(states: readonly { id: string; document: string }[], signal?: AbortSignal): Promise<DesignAuditResult[]>;
}

/** The private browser service's /audit job, or undefined when none is configured. */
export function configuredDesignAudit(env: BrowserCheckEnv): DesignAuditPort | undefined {
	const service = configuredBrowserChecks(env);
	if (!service) return undefined;
	return {
		async audit(states, signal) {
			const response = await service.fetch(new Request('https://caddie-capture.internal/audit', {
				method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ states }), signal,
			}));
			if (!response.ok) throw new Error(`the screen checker answered ${response.status}`);
			return (await response.json()) as DesignAuditResult[];
		},
	};
}

/**
 * Measure every look's first screen, rendered exactly as the owner will see it
 * in the picker (its theme + its screen), and turn the measurements into
 * findings the designer can act on. No browser service means nothing was
 * measured — recorded as an advisory finding, never as a pass of the
 * measurements themselves.
 */
export async function measureLooks(body: string, set: LooksSet, port: DesignAuditPort | undefined, signal?: AbortSignal): Promise<MachineFinding[]> {
	const states = set.looks.flatMap((look) => {
		const brief = [lookThemeBlock(look), '', '```html-mock first', (look.screen ?? set.screen).html, '```'].join('\n');
		return approvedAppearanceDocuments(brief).slice(0, 1).map((item) => ({ id: look.id, document: item.document }));
	});
	if (!port || !states.length)
		return [{ severity: 'advisory', criterion: 'measured on screen', detail: 'Contrast, tap sizes and fit were not measured: the private screen checker is not available.' }];
	const results = await port.audit(states, signal);
	const name = new Map(set.looks.map((look) => [look.id, look.name]));
	const findings: MachineFinding[] = [];
	for (const result of results) {
		const look = name.get(result.stateId) ?? result.stateId;
		for (const detail of result.contrast) findings.push({ severity: 'blocking', criterion: 'contrast', detail: `${look} (${result.viewport}): ${detail}` });
		for (const detail of result.targets) findings.push({ severity: 'blocking', criterion: 'tap size', detail: `${look} (${result.viewport}): ${detail}` });
		if (result.overflow) findings.push({ severity: 'blocking', criterion: 'fits the screen', detail: `${look} scrolls sideways at ${result.viewport === 'phone' ? '390' : '1440'}px wide; remove fixed widths so it fits.` });
	}
	return findings;
}

/** The same measurements for already-composed screens (a design brief's states). */
export async function measureStates(states: readonly { id: string; document: string }[], port: DesignAuditPort | undefined, signal?: AbortSignal): Promise<MachineFinding[]> {
	if (!port || !states.length)
		return [{ severity: 'advisory', criterion: 'measured on screen', detail: 'Contrast, tap sizes and fit were not measured: the private screen checker is not available.' }];
	const findings: MachineFinding[] = [];
	for (const result of await port.audit(states.slice(0, 12), signal)) {
		for (const detail of result.contrast) findings.push({ severity: 'blocking', criterion: 'contrast', detail: `${result.stateId} (${result.viewport}): ${detail}` });
		for (const detail of result.targets) findings.push({ severity: 'blocking', criterion: 'tap size', detail: `${result.stateId} (${result.viewport}): ${detail}` });
		if (result.overflow) findings.push({ severity: 'blocking', criterion: 'fits the screen', detail: `${result.stateId} scrolls sideways at ${result.viewport === 'phone' ? '390' : '1440'}px wide.` });
	}
	return findings;
}
