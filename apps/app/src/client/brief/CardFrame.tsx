import type { ReactNode } from 'react';
import { Icon } from '../icons.tsx';
import { CARD_DESIGNS, type CardDesign } from './card-design.ts';

export function CardHeader({ design, context, status, fresh }: {
 design: CardDesign; context?: string; status: string; fresh?: boolean;
}) {
 const view = CARD_DESIGNS[design];
 return (
  <div className="compact-card-head">
   <span className="compact-card-kicker">
    <span className="compact-card-icon" aria-hidden="true"><Icon name={view.icon} title="" /></span>
    <span>{context ? <span className="card-context">{context} · </span> : null}{view.label}</span>
    {design === 'build' || design === 'repair' ? <span className="compact-card-pulse" aria-hidden="true" /> : null}
   </span>
   <span className="compact-card-badge">{status}</span>
   {fresh ? <span className="compact-card-new">New</span> : null}
  </div>
 );
}

export function CardPanel({ title, children }: { title: string; children: ReactNode }) {
 return <div className="compact-card-panel"><p className="compact-card-panel-title">{title}</p>{children}</div>;
}
