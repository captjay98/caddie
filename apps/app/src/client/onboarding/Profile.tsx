import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Mascot, type MascotMood } from '@caddie/ui/Mascot';
import { Icon, type IconName } from '../icons.tsx';
import { useProfile, type ProfileRecord } from '../queries.ts';
import { fetchJson } from '../api.ts';

const countryCodes = 'AF AL DZ AS AD AO AI AQ AG AR AM AW AU AT AZ BS BH BD BB BY BE BZ BJ BM BT BO BQ BA BW BV BR IO BN BG BF BI CV KH CM CA KY CF TD CL CN CX CC CO KM CG CD CK CR CI HR CU CW CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FK FO FJ FI FR GF PF TF GA GM GE DE GH GI GR GL GD GP GU GT GG GN GW GY HT HM VA HN HK HU IS IN ID IR IQ IE IM IL IT JM JP JE JO KZ KE KI KP KR KW KG LA LV LB LS LR LY LI LT LU MO MG MW MY MV ML MT MH MQ MR MU YT MX FM MD MC MN ME MS MA MZ MM NA NR NP NL NC NZ NI NE NG NU NF MK MP NO OM PK PW PS PA PG PY PE PH PN PL PT PR QA RE RO RU RW BL SH KN LC MF PM VC WS SM ST SA SN RS SC SL SG SX SK SI SB SO ZA GS SS ES LK SD SR SJ SE CH SY TW TJ TZ TH TL TG TK TO TT TN TR TM TC TV UG UA AE GB US UM UY UZ VU VE VN VG VI WF EH YE ZM ZW'.split(' ');
const names = new Intl.DisplayNames(['en'], { type: 'region' });
const countries = countryCodes.map(code => ({ code, name: names.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name));
const suggestedInterests = ['AI', 'Education', 'Health', 'Climate', 'Finance', 'Developer tools', 'Games', 'Accessibility'];
const MAX_CHIPS = 12;

export function OnboardingProfile({ actorId, onDone }: { actorId: string; onDone: () => Promise<void> }) {
 const profile = useProfile({ actorId });
 if (profile.isPending) return <p role="status">Loading your profile…</p>;
 if (profile.error) return <div role="alert"><p>We couldn’t load your profile.</p><button className="btn-ghost" onClick={() => void profile.refetch()}>Try again</button></div>;
 return <ProfileForm initial={profile.data?.profile ?? null} actorId={actorId} onDone={onDone} />;
}

function ProfileForm({ initial, actorId, onDone }: { initial: ProfileRecord | null; actorId: string; onDone: () => Promise<void> }) {
 const cache = useQueryClient();
 const [step, setStep] = useState(0);
 const heading = useRef<HTMLHeadingElement>(null);
 useEffect(() => { heading.current?.focus(); }, [step]);
 const steps = [
  { label: 'About you', title: 'Where are you joining from?', description: 'Your location helps me check eligibility and show deadlines in your time zone.' },
  { label: 'What you’re into', title: 'A little about how you build', description: 'Just the essentials — I’ll learn the rest as we work together, and you can always add more in Settings.' },
 ];
 const [country, setCountry] = useState(initial?.country ?? '');
 const [countryQuery, setCountryQuery] = useState(initial?.country ? (names.of(initial.country) ?? '') : '');
 const [timezone, setTimezone] = useState(initial?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
 const [format, setFormat] = useState(initial?.formatPreference ?? '');
 const [experience, setExperience] = useState(initial?.experienceLevel ?? '');
 const [interests, setInterests] = useState<string[]>(initial?.freeTextInterests ?? []);
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState<string | null>(null);
 const lastStep = steps.length - 1;
 const mood: MascotMood = step === 0 ? 'listening' : 'building';
 async function save() {
  if (busy) return;
  setBusy(true); setError(null);
  try {
   // Minimal onboarding: only the essentials are set here. Every other field
   // (skills, highlight, tools, budget, hours) is preserved from the existing
   // profile and is captured later in conversation (update_profile / remember)
   // or edited in Settings — onboarding is no longer a wall for them.
   const result = await fetchJson<{ profile: ProfileRecord }>('/api/profile', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    country,
    timezone,
    experienceLevel: experience,
    formatPreference: format === '' ? null : format,
    freeTextInterests: interests,
   }) });
   cache.setQueryData(['profile', actorId], result);
   await onDone();
  } catch (err) { setError(err instanceof Error ? err.message : 'We couldn’t save your profile. Please try again.'); }
  finally { setBusy(false); }
 }
 return <section className="card-surface onboarding-card" data-testid="onboarding-profile">
  <header className="onboarding-head">
   <span className="onboarding-head-mascot" aria-hidden="true"><Mascot mood={mood} size={44} live /></span>
   <div className="onboarding-head-progress">
    <p className="onboarding-head-step">Step {step + 1} of {steps.length}{step === lastStep ? ' · almost done' : ''}</p>
    <ol className="onboarding-bar" aria-label="Profile setup progress">{steps.map((item, index) => <li key={item.label} aria-current={step === index ? 'step' : undefined} data-done={index < step} data-current={index === step}><span className="sr-only">{item.label}</span></li>)}</ol>
   </div>
  </header>
  <h1 ref={heading} tabIndex={-1} className="onboarding-title">{steps[step]!.title}</h1>
  <p className="onboarding-lede">{steps[step]!.description}</p>
  <form onSubmit={event => { event.preventDefault(); if (step < lastStep) { if (step === 0 && !country) { setError('Please choose your country from the list as you type.'); return; } setError(null); setStep(step + 1); } else { if (!experience || !format) { setError('Please choose your experience and how you’d like to take part.'); return; } void save(); } }}>
   <fieldset disabled={busy}>
    {step === 0 ? <>
    <div className="onboarding-fieldgroup">
    <label className="onboarding-field">Where do you live?<input className="input" required list="onboarding-countries" placeholder="Start typing your country" value={countryQuery} onChange={event => { setCountryQuery(event.target.value); const match = countries.find(c => c.name.toLowerCase() === event.target.value.trim().toLowerCase()); setCountry(match ? match.code : ''); }} /><small>Start typing to search. Some hackathons only accept entrants from certain countries — this lets me flag that early.</small></label>
    <datalist id="onboarding-countries">{countries.map(item => <option key={item.code} value={item.name} />)}</datalist>
    <label className="onboarding-field">Your time zone<input className="input" required list="onboarding-timezones" value={timezone} onChange={event => setTimezone(event.target.value)} /><small>Detected from your device — change it if that’s not right. I use it to show deadlines in your local time.</small></label>
    </div>
    <datalist id="onboarding-timezones">{Intl.supportedValuesOf('timeZone').map(zone => <option key={zone} value={zone} />)}</datalist>
    </> : null}
    {step === 1 ? <>
    <SegmentField
     legend="How much have you built before?"
     testId="onboarding-experience"
     value={experience}
     onChange={(value) => setExperience(value as typeof experience)}
     options={[
      { value: 'beginner', label: 'New to it', icon: 'sparkCheck' },
      { value: 'intermediate', label: 'A few apps', icon: 'box' },
      { value: 'senior', label: 'Experienced', icon: 'target' },
     ]}
    />
    <SegmentField
     legend="How do you want to take part?"
     testId="onboarding-format"
     value={format}
     onChange={(value) => setFormat(value as typeof format)}
     options={[
      { value: 'online', label: 'Online' },
      { value: 'in_person', label: 'In person' },
      { value: 'either', label: 'Either' },
     ]}
    />
    <ChipField legend="What would you enjoy building?" optional hint="Pick what you’d enjoy — or skip it and tell me as we go." suggestions={suggestedInterests} selected={interests} onChange={setInterests} testId="onboarding-interests" />
    <p className="onboarding-defer-note"><span aria-hidden="true">💬</span> That’s all I need. I’ll pick up your skills, tools and the rest from our first conversation — and you can set them anytime in Settings.</p>
    </> : null}
    {error ? <p role="alert" className="form-error">{error}</p> : null}
    <div className="onboarding-step-actions">
     {step > 0 ? <button className="btn-ghost" type="button" onClick={() => { setError(null); setStep(step - 1); }}>Back</button> : null}
     <button className="btn-key" type="submit" data-testid={step === lastStep ? 'onboarding-profile-save' : 'onboarding-profile-continue'}>{busy ? 'Saving your profile…' : step === lastStep ? 'Save and meet Caddie' : 'Continue'}</button>
    </div>
   </fieldset>
  </form>
 </section>;
}

/**
 * A segmented single-choice picker (keyboard-accessible radiogroup): tappable
 * cards instead of a dropdown. The selected value is reflected on the group
 * via data-value so a test can read it; each option is a real radio button.
 */
function SegmentField({ legend, options, value, onChange, testId }: {
 legend: string;
 options: readonly { value: string; label: string; icon?: IconName }[];
 value: string;
 onChange: (value: string) => void;
 testId: string;
}) {
 return <fieldset className="onboarding-segment" data-testid={testId} data-value={value}>
  <legend>{legend}</legend>
  <div className="segment-options" role="radiogroup" aria-label={legend}>
   {options.map(option => <button
    key={option.value}
    type="button"
    role="radio"
    aria-checked={value === option.value}
    className="segment-option"
    data-selected={value === option.value}
    data-value={option.value}
    onClick={() => onChange(option.value)}
   >{option.icon ? <span className="segment-icon" aria-hidden="true"><Icon name={option.icon} title="" /></span> : null}<span className="segment-label">{option.label}</span></button>)}
  </div>
 </fieldset>;
}

/**
 * Selectable chips with an "Add your own" input: suggestions toggle into the
 * selected row, typed entries join it on Enter, and every selected chip has a
 * remove button — no comma-separated typing.
 */
function ChipField({ legend, hint, suggestions, selected, onChange, testId, optional }: { legend: string; hint: string; suggestions: readonly string[]; selected: string[]; onChange: (next: string[]) => void; testId: string; optional?: boolean }) {
 const [draft, setDraft] = useState('');
 const full = selected.length >= MAX_CHIPS;
 function add(value: string) {
  const item = value.trim().slice(0, 60);
  if (item === '' || selected.includes(item) || full) return;
  onChange([...selected, item]);
  setDraft('');
 }
 const remaining = suggestions.filter(item => !selected.includes(item));
 return <fieldset className="onboarding-chips" data-testid={testId}>
  <div className="chips-legend">
   <legend>{legend}{optional ? <span className="onboarding-optional-tag"> · optional</span> : null}</legend>
   <span className="chips-count" aria-hidden="true">{selected.length}/{MAX_CHIPS}</span>
  </div>
  <p className="chips-hint">{hint}</p>
  <div className="chip-flow">
   {selected.map(item => <button key={item} type="button" className="chip chip-on" data-selected="true" aria-pressed="true" onClick={() => onChange(selected.filter(value => value !== item))}>
    <span>{item}</span><span className="chip-x" aria-hidden="true"><Icon name="x" title="" /></span>
    <span className="sr-only">Remove {item}</span>
   </button>)}
   {remaining.map(item => <button key={item} type="button" className="chip" aria-pressed="false" disabled={full} onClick={() => onChange([...selected, item])}>{item}</button>)}
   <input
    className="chip-add"
    value={draft}
    maxLength={60}
    aria-label="Add your own interest"
    placeholder={full ? `Up to ${MAX_CHIPS}` : '+ add your own'}
    disabled={full}
    onChange={event => setDraft(event.target.value)}
    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(draft); } }}
   />
  </div>
 </fieldset>;
}
