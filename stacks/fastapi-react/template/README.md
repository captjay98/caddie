# forge-fastapi-template

FastAPI service + Vite React client. uv manages Python; Bun runs the client
toolchain.

## Layout

- `app/` — the FastAPI service (`app/main.py` app, `app/models.py` pydantic
  contract). State is server-side for the process lifetime; durable storage
  is a user-project change, not scaffolding.
- `client/` — the Vite React client. Dev proxies `/api` to the service
  (same-origin, no CORS); split origins need `VITE_API_BASE` on the client
  and an explicit `CADDIE_CLIENT_ORIGIN` allowlist on the service (never a
  wildcard).
- `tests/` — pytest contract tests over the real ASGI app.

## Commands (the recipe's contract)

```sh
uv sync                                   # Python env + dev tools
uv run pytest                             # API contract tests
bun install                               # client deps (workspace hoisted)
bun run build                             # client production build -> client/dist
uv run uvicorn app.main:app --port 8080   # serve the API
```

`CADDIE_CLIENT_ORIGIN` is read at startup; unset it means same-origin only.

The first `uv sync` generates `uv.lock` — commit it, and reproducible
environments (CI, sandbox) then run `uv sync --frozen`.
