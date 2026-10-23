/**
 * The choose-a-look step for tests whose subject is a LATER step (design
 * review, building, publishing): a valid looks proposal (the owner-approved
 * Field-ready / Calm and clear / Warm and bold looks,
 * docs/reviews/2026-10-23-look-and-feel-picker) and helpers that save it and
 * choose a look, landing the workflow in 'design' exactly as the owner's click
 * would.
 */
import { LOOKS_BLOCK_INFO, type Scope } from '@caddie/contracts';
import type { D1Database } from '../../apps/app/src/server/auth.ts';
import { createPlanDocRevision } from '../../apps/app/src/server/projects.ts';
import { decideLooks, workflowSnapshot } from '../../apps/app/src/server/build-workflow.ts';

export const FIELD_LOOK = {
	id: 'field',
	name: 'Field-ready',
	why: 'Dark text on a light background, with big buttons. Easy to read in bright sun.',
	colors: { bg: '#F7F5EF', surface: '#FFFFFF', text: '#1B1F1A', muted: '#5A6157', primary: '#1F7A3A', onPrimary: '#FFFFFF', border: '#D9D6CC', ok: '#1F7A3A', warn: '#9A4A00', danger: '#B42318' },
	stateSurfaces: [{ name: 'warnBg', bg: '#FFF4E5', fg: '#9A4A00', plain: 'Behind a warning.' }],
	fonts: { heading: 'system-ui, -apple-system, "Segoe UI", sans-serif', body: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
	radius: 10,
	density: 'roomy',
};
export const CALM_LOOK = {
	id: 'calm',
	name: 'Calm and clear',
	why: 'Soft blues and plenty of space. Feels steady for money and the lender report.',
	colors: { bg: '#F4F7FB', surface: '#FFFFFF', text: '#142033', muted: '#5B6B82', primary: '#2B5FD9', onPrimary: '#FFFFFF', border: '#DCE3EE', ok: '#1F7A3A', warn: '#94520A', danger: '#B42318' },
	fonts: { heading: '"Avenir Next", Avenir, "Segoe UI", system-ui', body: '"Avenir Next", Avenir, "Segoe UI", system-ui' },
	radius: 14,
	density: 'comfortable',
};
export const WARM_LOOK = {
	id: 'warm',
	name: 'Warm and bold',
	why: 'Dark background with amber highlights. Gentle on the eyes at dawn and dusk.',
	colors: { bg: '#15120E', surface: '#221D17', text: '#F5EFE6', muted: '#B8AC9A', primary: '#F2A541', onPrimary: '#1A1208', border: '#3A3228', ok: '#7BD88F', warn: '#FFB86B', danger: '#FF8A80' },
	fonts: { heading: 'ui-rounded, "SF Pro Rounded", system-ui', body: 'ui-rounded, "SF Pro Rounded", system-ui' },
	radius: 20,
	density: 'comfortable',
};

export const LOOKS_SET = {
	audience: 'poultry and catfish farmers, mostly on their phones in the sheds',
	recommended: 'field',
	looks: [FIELD_LOOK, CALM_LOOK, WARM_LOOK],
};

export const LOOKS_SCREEN =
	'```html-mock Today\n<main style="background:var(--bg);color:var(--text);font-family:var(--font-body)"><h1>Today in your sheds</h1><p style="color:var(--muted)">Broilers · day 21</p><button style="background:var(--primary);color:var(--on-primary);border-radius:var(--radius)">Hold to speak</button></main>\n```';

export function looksBody(set: unknown = LOOKS_SET, screen = LOOKS_SCREEN): string {
	return ['Three starting looks for the app.', '```' + LOOKS_BLOCK_INFO, JSON.stringify(set, null, 2), '```', screen].join('\n');
}

export const LOOKS_BODY = looksBody();

/** Save the looks proposal (as the designer would) and advance looks -> looks-review. */
export async function saveLooks(db: D1Database, scope: Scope, body = LOOKS_BODY) {
	const looks = await createPlanDocRevision(db, scope, { kind: 'looks', body });
	const snapshot = await workflowSnapshot(db, scope);
	return { looks, snapshot };
}

/** After the plan is approved: save the looks and choose one, landing in 'design'. */
export async function chooseLook(db: D1Database, scope: Scope, choice = 'field', limits?: unknown) {
	const { looks } = await saveLooks(db, scope);
	const snapshot = await decideLooks(db, scope, { looksId: looks.id, choice }, limits);
	return { looks, snapshot };
}
