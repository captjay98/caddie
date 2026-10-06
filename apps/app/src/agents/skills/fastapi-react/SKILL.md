# FastAPI + React stack skill (P15c v1)

Build and verify FastAPI backends with React clients in the sandbox.

## Discipline

- uv-managed Python environment: `uv sync --frozen` before anything; never
  pip-install ad hoc.
- pytest green + client tests green before claiming anything; both suites
  count — one green suite is not verification.
- CORS and session policy are explicit: the React client origin is allowlisted
  per environment, never a wildcard in any deployed preview.
- Contract generation (OpenAPI client) is a build step, checked in.
- Report exact uv/pytest/bun commands and exit codes.
