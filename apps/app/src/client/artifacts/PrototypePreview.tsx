import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { themeToCssVars, type AppTheme, type DesignPrototype } from '@caddie/contracts';
import './prototype.css';

/** A declarative, ephemeral journey. No generated script, HTML, requests or persistence. */
export function PrototypePreview({ prototype, theme }: { prototype: DesignPrototype; theme?: AppTheme | null }) {
 const [open, setOpen] = useState(false);
 const [screenId, setScreenId] = useState(prototype.start);
 const [values, setValues] = useState<Record<string, string>>({});
 const heading = useRef<HTMLHeadingElement>(null);
 const screen = prototype.screens.find(candidate => candidate.id === screenId) ?? prototype.screens[0]!;
 useEffect(() => { if (open) heading.current?.focus(); }, [open, screenId]);
 const themeStyle = theme ? Object.fromEntries([...themeToCssVars(theme).matchAll(/(--[a-zA-Z0-9-]+):\s*([^;]+);/g)].map(match => [match[1]!, match[2]!.trim()])) as CSSProperties : {};
 const reset = () => { setValues({}); setScreenId(prototype.start); };
 const labels = new Map(prototype.screens.flatMap(screen => screen.fields.map(field => [`${screen.id}:${field.id}`, field.label])));
 return <section className="prototype-preview" data-testid="design-prototype">
  <div className="prototype-intro"><div><h3>{prototype.title}</h3><p>{prototype.reason}</p></div><button type="button" className="btn-ghost" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Close sample flow' : 'Try the sample flow'}</button></div>
  {open ? <>
   <p className="state-detail" role="status">Sample flow · nothing is saved or sent. AI, offline use and connected services are checked after building.</p>
   <div className="prototype-canvas" style={themeStyle}>
    <h4 ref={heading} tabIndex={-1}>{screen.title}</h4><p>{screen.body}</p>
    {screen.fields.map(field => <label key={field.id} className="prototype-field">{field.label}<input type="text" maxLength={240} autoComplete="off" value={values[`${screen.id}:${field.id}`] ?? ''} placeholder={field.placeholder} onChange={event => setValues(previous => ({...previous, [`${screen.id}:${field.id}`]:event.target.value}))} /></label>)}
    {screen.fields.length === 0 && Object.keys(values).length ? <dl className="prototype-values">{Object.entries(values).filter(([, value]) => value.trim()).map(([key, value]) => <div key={key}><dt>{labels.get(key)}</dt><dd>{value}</dd></div>)}</dl> : null}
    <div className="prototype-actions">{screen.actions.map(action => <button key={action.id} type="button" onClick={() => setScreenId(action.to)}>{action.label}</button>)}</div>
   </div>
   <button type="button" className="btn-ghost" onClick={reset}>Restart sample</button>
  </> : null}
 </section>;
}
