# Caddie redesign — brand spec

Source: `caddie-forge/packages/ui/src/tokens.css` (halo seeds, read 2026-10-09). Seeds are bound verbatim; derived colours use `color-mix`/`oklch`.

| Token | Dark | Light |
|---|---|---|
| `--bg` | `#090b10` ≈ oklch(0.15 0.01 265) | `#f6f8fc` |
| `--surface` | `#101319` | `#ffffff` |
| `--fg` | `#e6e9ef` | `#0b101a` |
| `--muted` | `#8b93a3` | `#4c5768` |
| `--border` | fg @ 13% | fg @ 16% |
| `--accent` (action) | `#4d9fff` | `#155fbe` |

State: ok `#3ecf8e`/`#007b44` · warn `#f0a83c`/`#9c5a05` · danger `#ff7a83`/`#c13846`.

Fonts: display + body `Inter` (brand-locked) · mono `IBM Plex Mono` for kickers, identifiers, routes, timestamps.

Rules
1. Type floor: labels 11px, anything carrying a state/identifier 12px.
2. Radius 10px on panels, 8px on controls, full on chips.
3. One flourish: the horizon radial glow at the top of the content column.
4. Filled action buttons use ink text on blue in dark (7:1), white on blue in light (5.8:1).
5. Internal nouns (claims, revisions, artifacts) live in detail views only — never in titles or nav.
