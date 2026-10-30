# Change proposal and saved-base continuation

**Status: LOCAL VERIFIED / SIMULATED.** The host workflow tests use migrated
SQLite and a sandbox stub; browser checks use mocked API boundaries and an
isolated local dev server. No paid rebuild, live provider acceptance, production
database migration or deployment is established by these checks.

- Migration 0057 adds nullable proposal and hash fields without rewriting old
  records. A newly requested change remains pending until the coordinator saves
  a bounded proposal describing its scope, risks and checks. Approval binds the
  saved proposal and request hashes to the previous output; a cancelled, stale,
  unauthorized or malformed proposal is refused.
- An approved change receives a fresh sandbox session anchored to the checked
  image of its prior output. When that image is gone, recovery selects a saved
  code version by that exact output, removes unrelated files from its newly
  created runtime workspace, restores the selected source and verifies install.
  The continuation records the selected output and commit to recover after an
  interruption without picking a newer unrelated version. If neither image nor
  saved source is available, it fails closed while retaining the old preview.
- The browser shows the saved scope before enabling approval. An in-progress
  proposal is polled and can be cancelled. This interaction still needs proof
  across an actual coordinator restart and a paid real change build.
- Judge-limit refusal restores the previous payer and proposal state. A stale
  admission claim is returned to review after two minutes while the original
  preview stays available; its token fences a delayed worker from starting it.
  These are simulated interruption checks, not proof of real process recovery
  or of external spending reconciliation across a crash.
- Existing Farmhand previews remain untouched. Migration 0057 is not confirmed
  applied to the active local or production database. Apply it before testing
  this version; never reset the database.
