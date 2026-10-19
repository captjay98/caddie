# Third-party licences

A licence audit of Caddie's shipped **production** dependencies: their declared
licence, and whether it falls outside the set this project accepts.

- Generated: 2026-10-19T01:54:03.386Z
- Regenerate with: `bun scripts/license-audit.ts`
- Never edit this file by hand; the script rewrites it.

## Method

- Locations: `apps/app`, every package under `packages/*`, the react-hono
  template (`stacks/react-hono/template/package.json` and the scaffold it
  generates, `stacks/react-hono/scaffold.ts`) and every worker under `workers/*`.
- Dependencies: the declared production `dependencies` of each location.
  `devDependencies` are build tooling that does not ship, so they are not
  audited. First-party `workspace:*` links are listed but not treated as
  third-party licences.
- Licence value: `license` in the package's `node_modules/<name>/package.json`;
  falling back to a legacy `licenses` array, then to the text of the package's
  `LICENSE` file. Where a fallback was used, the table says so.
- Allowed set: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD.
- SPDX expressions are allowed only when every named operand is in the set
  (e.g. `(MIT OR Apache-2.0)` is allowed; a `WITH <exception>` clause keeps the
  base licence id). This is stricter than an OR requires, deliberately.
- Direct declared dependencies only; the transitive tree is not walked.
- Exit code 0 only when nothing is flagged and nothing is unresolved.

## Summary

24 production dependencies audited across 5 locations: 22 allowed, 2 flagged, 0 unresolved.

### apps/app

Declared in: `apps/app/package.json`.

| Package | Version | Licence | Range |
| --- | --- | --- | --- |
| `@earendil-works/pi-ai` | 0.87.1 | MIT | `0.87.1` |
| `@flue/react` | 2.2.2 | Apache-2.0 | `2.2.2` |
| `@flue/runtime` | 2.2.2 | Apache-2.0 | `2.2.2` |
| `@flue/sdk` | 2.2.2 | Apache-2.0 | `2.2.2` |
| `@fontsource/ibm-plex-mono` | 5.3.0 | OFL-1.1 | `^5.3.0` |
| `@fontsource/inter` | 5.3.0 | OFL-1.1 | `^5.3.0` |
| `@tanstack/react-query` | 5.104.1 | MIT | `5.104.1` |
| `@tanstack/react-router` | 1.170.41 | MIT | `1.170.41` |
| `@vitejs/plugin-react` | 4.7.0 | MIT | `^4.7.0` |
| `better-auth` | 1.7.10 | MIT | `1.7.10` |
| `hono` | 4.13.12 | MIT | `^4.12.32` |
| `isomorphic-git` | 1.44.2 | MIT | `1.44.2` |
| `nanoid` | 5.1.16 | MIT | `^5.1.16` |
| `react` | 19.3.0 | MIT | `^19.2.0` |
| `react-dom` | 19.3.0 | MIT | `^19.2.0` |
| `react-markdown` | 10.1.0 | MIT | `10.1.0` |
| `remark-gfm` | 4.0.1 | MIT | `4.0.1` |

### packages/contracts

Declared in: `packages/contracts/package.json`.

| Package | Version | Licence | Range |
| --- | --- | --- | --- |
| `valibot` | 1.5.0 | MIT | `^1.1.0` |

### packages/ui

Declared in: `packages/ui/package.json`.

| Package | Version | Licence | Range |
| --- | --- | --- | --- |
| `react-markdown` | 10.1.0 | MIT | `10.1.0` |
| `remark-gfm` | 4.0.1 | MIT | `4.0.1` |

### react-hono template (and the scaffold it generates)

Declared in: `stacks/react-hono/template/package.json + stacks/react-hono/scaffold.ts (SCAFFOLD_PACKAGE)`.

| Package | Version | Licence | Range |
| --- | --- | --- | --- |
| `better-auth` | 1.7.10 | MIT (resolved via apps/app) | `1.7.10` |
| `hono` | 4.13.12 | MIT (resolved via apps/app) | `4.12.32` |
| `react` | 19.3.0 | MIT (resolved via apps/app) | `19.2.0` |
| `react-dom` | 19.3.0 | MIT (resolved via apps/app) | `19.2.0` |

### workers/dispatch

Declared in: `no package.json — declares no dependencies`.

no package.json; imports workspace packages by relative path, so it declares no third-party production dependency.

No production dependencies.

### First-party workspace links (skipped)

| Location | Package | Range |
| --- | --- | --- |
| apps/app | `@caddie/contracts` | `workspace:*` |
| apps/app | `@caddie/ui` | `workspace:*` |

## Flagged

These are outside the allowed set and need a decision (replace, or record why they are acceptable):

| Package | Version | Licence | Why it is flagged |
| --- | --- | --- | --- |
| `@fontsource/ibm-plex-mono` | 5.3.0 | OFL-1.1 | not in the allowed set |
| `@fontsource/inter` | 5.3.0 | OFL-1.1 | not in the allowed set |

## Unresolved

Nothing: every declared production dependency was found in `node_modules` with a readable licence.
