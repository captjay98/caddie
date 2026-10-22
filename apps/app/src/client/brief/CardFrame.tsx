import type { ReactNode } from 'react';
import { Icon } from '../icons.tsx';
import { CARD_DESIGNS, type CardDesign } from './card-design.ts';

export function CardHeader({ design, context, status, fresh, freshLabel }: {
 design: CardDesign; context?: string; status: string; fresh?: boolean; freshLabel?: string;
}) {
 const view = CARD_DESIGNS[design];
 const pulsing = design === 'build' || design === 'repair';
 return (
  <div className="compact-card-head">
   <span className="compact-card-kicker">
    {pulsing ? <span className="compact-card-pulse" aria-hidden="true" /> : <span className="compact-card-icon" aria-hidden="true"><Icon name={view.icon} title="" /></span>}
    <span>{context ? <span className="card-context">{context} · </span> : null}{view.label}</span>
    {/* "· time" freshness, when the caller supplied an updated-at label. */}
    {freshLabel ? <span className="compact-card-fresh" data-testid="card-fresh">· {freshLabel}</span> : null}
   </span>
   {status ? <span className="compact-card-badge">{status}</span> : null}
   {fresh ? <span className="compact-card-new">New</span> : null}
  </div>
 );
}

export function CardPanel({ title, children, tone }: { title: string; children: ReactNode; tone?: 'caution' }) {
 return <div className="compact-card-panel" data-panel-tone={tone}><p className="compact-card-panel-title">{title}</p>{children}</div>;
}

/**
 * The four-stage build rail (mockup "Live build"). It reports WHERE the build
 * is, from the card's design alone — no new data: a `build` card is at
 * "Building", a `repair` card is at "Checking". Plan approval always precedes
 * both, and "Ready to try" is the step still to come. The preview card uses
 * its own ready layout, so the rail is only shown for build and repair.
 */
export function BuildRail({ design }: { design: CardDesign }) {
 const active = design === 'repair' ? 'check' : 'build';
 const order = ['plan', 'build', 'check', 'preview'] as const;
 const labels: Record<(typeof order)[number], string> = {
  plan: 'Plan approved', build: 'Building', check: 'Checking', preview: 'Ready to try',
 };
 const activeIndex = order.indexOf(active);
 return (
  <ol className="compact-card-rail" aria-label="Build stages" data-testid="card-build-rail">
   {order.map((step, index) => {
    const state = index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'pending';
    return <li key={step} className="compact-card-step" data-state={state} data-step={step}>{labels[step]}</li>;
   })}
  </ol>
 );
}

/**
 * The card footer (mockup `cc-bottom`): a quiet two-part rule under the
 * actions. The left side names the app (and an optional version) when the card
 * carries a footer record; otherwise it falls back to the subject label. The
 * right side is the standing reassurance. An empty footer renders nothing.
 */
export function CardFooter({ subject, note, app, version }: { subject?: string; note?: string; app?: string; version?: string }) {
 const left = app ? (version ? `${app} · ${version}` : app) : subject;
 if (!left && !note) return null;
 return (
  <div className="compact-card-foot" data-testid="card-foot">
   {left ? <span className="compact-card-foot-subject" data-testid="card-foot-subject">{left}</span> : <span />}
   {note ? <span className="compact-card-foot-note">{note}</span> : null}
  </div>
 );
}
