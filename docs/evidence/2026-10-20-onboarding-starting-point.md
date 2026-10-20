# Onboarding: approved starting-point design

User accepted **Your starting point**, retaining today's Caddie with light Flag buddy polish. Implemented locally on 2026-10-20; no deployment or provider calls.

## Changes

- `apps/app/src/client/onboarding/Start.tsx`: replaced the timed paragraph/replay introduction with three native radio choices. The primary action follows the selection immediately. Kept the hackathon definition, account-name suggestion, editable name and Skip. Added Back to revise the starting point without losing the selection.
- `apps/app/src/client/workspace.css`: compact 13px corners, stacked mobile choices, readable labels, keyboard focus and a smaller companion beside the headline. Scoped softer blue/yellow mascot colors to this welcome; kept the existing drawing and state rig.
- `apps/app/src/client/routes.tsx`: completion defaults to Discover, idea entry or Home according to the selected choice. Preserves a valid previously captured same-origin destination. Accepts the bounded `start=idea` search value.
- `apps/app/src/client/workspace/Chrome.tsx`: `start=idea` opens the existing project-start prompt in the conversation; it creates no project or model call by itself.
- `tests/browser/onboarding-v2.spec.ts` and `onboarding-profile.spec.ts`: replaced superseded replay assertions, verified choice retention, destinations, reduced motion, short mobile layout and preserved profile behavior.

```tsx
const [startingPoint, setStartingPoint] = useState<StartingPoint>('hackathon');
// Completion destination, unless a valid earlier destination was saved:
let target = startingPoint === 'hackathon' ? '/app/discover'
  : startingPoint === 'idea' ? '/app/?start=idea&pane=channel' : '/app/';
```

## Defect discovered and fixed

**Reproduction:** choose an idea or the default hackathon, finish name/profile setup. Initial regression run landed on Home for both, failing two of four tests.

**Root cause:** completion updated the onboarding query cache, requested navigation, then cleared `busy` in `finally`. The completed-account redirect effect observed `busy=false` and issued its own Home redirect before the selected destination finished loading.

**Fix:** retain `busy` after successful completion until navigation unloads the page; clear it on error to permit retry.

```tsx
} catch {
  setError('We couldn’t save your progress. Please try again.');
  setBusy(false);
  throw new Error('We couldn’t finish setup. Please try again.');
}
// Do not clear busy on successful navigation.
```

## Evidence

- **LOCAL VERIFIED** — `bun run typecheck`: exit 0.
- **LOCAL VERIFIED** — `bun run build`: exit 0 after the redirect fix. Existing Vite plugin deprecation and bundle-size warnings remain.
- **LOCAL VERIFIED** — `bun test tests/onboarding.test.ts`: 1 pass, 8 assertions, exit 0; SQLite-backed actor-scoped completion/idempotency regression.
- **SIMULATED** — `bunx playwright test tests/browser/onboarding-v2.spec.ts tests/browser/onboarding-profile.spec.ts --workers=1 --reporter=line`: 6 passed in 11.2s, exit 0. Real composed UI with stubbed auth/profile/API responses; not authenticated provider proof.
- **LOCAL VERIFIED** — running dev app at `http://localhost:5176/app/onboarding`: actual signed-in welcome, choice changes CTA, Next opens the account-name step, Back preserves selection. At 320×568, document width equals viewport width (320px); the page scrolls vertically. Reviewed at 390×844 and the wider app panel. No live user profile was submitted by this check.
- **LOCAL VERIFIED** — `git diff --check`: exit 0.

Full cross-product mobile audit remains separate work; this verifies the changed onboarding surface. No claim of deployment or LIVE VERIFIED provider behavior.

## Follow-up: name step and consistent buttons

User identified the name step's oversized mascot and inconsistent actions. Its primary button used only the global `btn-key` style while the first step had its own sizing rules. Reused the compact starting-point shell/header and introduced a shared `welcome-primary` class on both primary actions:

```css
.welcome-intro .welcome-primary { min-height: 48px; padding: 12px 24px; }
.welcome-starting-point .welcome-primary { width: 100%; border-radius: 13px; font-size: 14px; }
```

Name entry now has a visible label, first-name autocomplete, a 16px left-aligned input, a short explanation, a full-width Continue button, and quiet Back/Skip actions. It is a real form so Enter submits through the same save handler. Existing name suggestion, safe text rendering, optional skip and selected starting-point handoff remain intact. Changed `Start.tsx` and `workspace.css` only for this follow-up.

- **LOCAL VERIFIED** — actual dev browser at 390×844: both steps' primary buttons measure 316×48px with 13px corners. At 320×568, the name page fits without horizontal overflow (document/viewport widths both 320); primary is 246×48px and Skip retains a 44px target. No profile was submitted in this real-account visual check.
- **LOCAL VERIFIED** — typecheck and final composed build exit 0.
- **SIMULATED** — reran both onboarding browser specs after the name-step change: all 6 passed in 5.9s. Backend/auth responses are stubbed; this is UI regression evidence.

## Follow-up: location/profile card

Continued the approved compact design onto profile setup. `Profile.tsx` uses the shared primary-action class, adds country autocomplete and shorter helper copy. `workspace.css` brings the profile shell to 440px maximum width, 13px corners, matching heading typography and 48px fields/actions. Previously its Continue used only the default short button style.

```css
.onboarding-card { max-width: 440px; border-radius: 13px; }
.onboarding-card .welcome-primary { width: 100%; border-radius: 13px; font-size: 14px; }
```

- **LOCAL VERIFIED** — dev browser: preserved the user's partial country input and detected time zone. At 390px, Continue is 316×48px with 13px corners, matching both earlier pages. At 320px, document and viewport widths both equal 320px; vertical scrolling remains available. Did not submit or replace the user's entries.
- **LOCAL VERIFIED** — typecheck, composed build and diff whitespace check exit 0.
- **SIMULATED** — the same six onboarding/profile browser regressions pass after the profile change (5.9s), including country validation and answer retention on Back.

## Final step: accepted Quick picks and original Caddie

Implemented the accepted Quick picks variant, including the later request for **Open to anything** as the first/default interest choice. Restored Caddie's original palette by removing the welcome-only color override; the existing drawing retains its bubbly eyes, highlights and pink cheeks. The final step uses the ready expression rather than implying a build is running.

- `Profile.tsx`: concise headline and helper copy, compact experience/participation controls, Back in the header, original mascot beside the headline, full-width **Finish setup**, quiet Settings note. Defaults an empty onboarding interest list to the existing broad-interest marker.
- `InterestPicker.tsx`: optional compact mode, first row containing Open to anything, AI & agents, Games, Social impact and More topics. Expanded mode preserves the complete searchable catalog, custom interests, selected values and the twelve-interest cap. Specific topics replace Open to anything; an empty list also displays the broad default. Settings retains its original expanded/search-first presentation because compact mode defaults to false.
- `workspace.css`: matching 13px corners and 48px primary action; reduced internal field spacing; original mascot colors restored.
- `onboarding-profile.spec.ts`: verifies the default broad choice, exclusivity, hidden initial search, expansion, custom interest persistence, 390px Finish visibility/48px height, and no horizontal overflow at 320px.

```tsx
<InterestPicker compact legend="What sparks your interest?" optional
  selected={interests} onChange={setInterests} testId="onboarding-interests" />
```

Verification:

- **LOCAL VERIFIED** — final `bun run typecheck`, composed `bun run build`, and `git diff --check`: exit 0.
- **LOCAL VERIFIED** — `bun test tests/interest-picker.test.ts`: 7 passed, 33 assertions. Existing exclusivity, cap, custom-interest and discovery-marker tests remain green.
- **SIMULATED** — `bunx playwright test tests/browser/onboarding-v2.spec.ts tests/browser/onboarding-profile.spec.ts tests/browser/settings.spec.ts --grep 'Welcome intro|Profile wizard|interests: the shared picker' --workers=1 --reporter=line`: 7 passed in 13.2s. Includes profile payload preservation and shared Settings regression. All use stubbed backend/auth responses.
- **SIMULATED** — reran the profile Back/validation test after adding responsive assertions and a screenshot: 1 passed in 10.3s. At 390×844, Finish is 48px high and inside the viewport; at 320px, document width does not exceed viewport width. The saved implementation screenshot uses a test account.
- **LOCAL VERIFIED** — dev app rendered Quick picks with the original mascot and broad default before the user independently completed onboarding and reached Discover. Left that completed session on Discover; did not reset onboarding or submit their final profile during verification.
