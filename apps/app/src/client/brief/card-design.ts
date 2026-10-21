import type { DecisionCard } from '@caddie/contracts';
export type CardDesign = 'plan' | 'build' | 'repair' | 'preview' | 'deadline' | 'opportunity' | 'earlier' | 'update';
/** Stable server identities and typed actions, never guesses from display prose. */
export function cardDesign(card: DecisionCard): CardDesign {
 if (card.id.startsWith('brf_workflow_build_')) return 'build';
 if (card.id.startsWith('brf_workflow_repair_')) return 'repair';
 if (card.primaryAction.kind === 'preview') return 'preview';
 if (card.kind === 'deadline') return 'deadline';
 if (card.id.startsWith('brf_opportunity_')) return 'opportunity';
 if (card.status === 'handled') return 'earlier';
 if (card.kind === 'approval') return 'plan';
 return 'update';
}
export const CARD_DESIGNS = {
 plan: { label: 'Your decision', icon: 'check', tone: 'blue' },
 build: { label: 'Building your app', icon: 'play', tone: 'blue' },
 repair: { label: 'Checking & repairing', icon: 'sparkCheck', tone: 'amber' },
 preview: { label: 'Your app is ready', icon: 'play', tone: 'green' },
 deadline: { label: 'Coming up', icon: 'calendar', tone: 'amber' },
 opportunity: { label: 'An opportunity for you', icon: 'target', tone: 'blue' },
 earlier: { label: 'Earlier', icon: 'check', tone: 'quiet' },
 update: { label: 'Project update', icon: 'info', tone: 'quiet' },
} as const;
