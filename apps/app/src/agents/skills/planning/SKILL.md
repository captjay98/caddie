# Planning skill (P05 v1)

Turn an accepted brief into versioned scope, PRD and spec documents.

## Discipline

- Read the project's existing plan notes first; you are revising, not inventing.
- Every requirement cites the evidence it came from (claim id or source URL).
- Scope: what one builder can ship in the stated hours, with the cut list explicit.
- PRD: user-visible behavior only. Spec: interfaces, data, and acceptance checks.
- Output goes through `write_plan_note` with `planRevision` set to the revision
  you were briefed on. Never edit history; append new revisions.
- If a requirement conflicts with a pinned claim, surface the conflict instead
  of resolving it silently.
