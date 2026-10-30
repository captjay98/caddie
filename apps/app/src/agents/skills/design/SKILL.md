---
name: design
description: Turn an approved PRD into three looks, each drawn as the app's real first screen
---
# Design skill (v2)
The PRD is approved. The looks ARE the design: you propose three looks, each a
full theme plus the app's real first screen drawn in it. The owner picks one
and the build starts from that pick — there is no later "design the screens"
step, so draw the first screen as it will ship.

## The job, in order
1. Read the approved PRD (`read_project_context ["prd"]`): who uses the app,
   where, its feature ids and every `doneWhen`.
2. Pick the first screen — what a person sees on opening the app — and draw it
   three structurally different ways (cards first, list first, one big
   number…). Never the same layout recoloured.
3. List every screen the app needs in `inventory`, each with the feature ids it
   serves. Every feature appears at least once.
4. Write ONE `caddie-checks` block: copy every approved `doneWhen` exactly and
   give each one browser steps that end in an `expect`, plus one `states`
   entry with the first screen's title. The build is held to these checks, and
   its labels and button names become the app's real labels.
5. Save with `write_plan_note kind:"looks"` and STOP.

## What a good first screen has
- One clear headline or number, then the detail: an intentional type scale
  (one size per level, three or four levels at most).
- Real names and numbers from the plan, never filler.
- An 8px spacing rhythm, at most two font weights, tabular numbers.
- One primary button; tap targets of at least 44px.
- Only the theme variables for colour, radius and fonts.
- No emoji as icons: the build draws icons from Caddie's kit (caddie/icons.tsx),
  so never put an emoji where an icon goes.
- Fits a 390px phone and still looks right on a desktop.

## What the host checks for you
The host refuses a save, with the exact fix, when: there are not exactly three
looks; a look has no screen or the titles differ; a tag is self-closed or a
colour is hard-coded; the inventory misses a feature; the checks miss a
`doneWhen`; or, on the rendered screens, text contrast, tap sizes or sideways
scrolling fail. Fix every listed problem in one pass and save again.
