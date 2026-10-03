# Flue runtime contract lessons (pin: 2.2.2)

Paid for in iterations during the Nebius-forge evaluation and adjudication
(`/Users/captjay98/projects/nebius-forge-eval/adjudication/`). Read before
writing agent code; re-verify every item on any version bump. Exact installed
versions live in `bun.lock` / `apps/app/package.json`.

## Pinned versions (P00 baseline)

| Package | Version |
|---|---|
| `@flue/runtime` | 2.2.2 (exact) |
| `@flue/cli` | 2.2.2 (exact) |
| `@flue/vite` | 2.2.2 (exact) |
| `@flue/react` | 2.2.2 (exact) |
| `@flue/sdk` | 2.2.2 (exact) |
| `@earendil-works/pi-ai` | 0.87.1 (evaluated; needed for custom providers — add in P05) |
| `@cloudflare/vite-plugin` | 1.39.2 (exact — newer minors break preview; see toolchain notes) |
| `vite` | 8.0.14 (exact) |
| `wrangler` | 4.113.0 (exact) |

Do not widen these ranges casually; Flue is young and API drift is the
documented maintenance tax.

## Authoring agents

- Agents are TypeScript functions. A module whose **first line is
  `'use agent'`** exports agents; every exported capitalized function is one,
  and the function name is its durable identity. The return value is the
  system prompt.
- Tool schemas use **Valibot** (not zod, not JSON Schema).
- Tools implement **`run(ctx)`** with the input under **`ctx.data`** and the
  `{ output }` envelope as the return.
- **Subagent renders reject `useModel`/`usePersistentState`** — the model
  goes on the `useSubagent()` definition; state passes through the task
  prompt.
- **`useAgentFinish`** is the completion enforcement hook: wire it so an
  unfinished run cannot be reported complete (adjudication observed a blocked
  coordinator turn an honest FAILED settlement through this gate).
- Approval/design gates belong in the write path as durable records checked
  before effects — conversational continuity alone is not authorization.

## Providers

- `flue.config.ts` `providers` takes **built-in provider IDs**, not paths.
  Custom provider registration belongs in **`src/app.ts`** via
  `setProvider(...)` (the runtime's documented precedence point).
- pi-ai lazy imports are **extensionless** (e.g.
  `@earendil-works/pi-ai/api/openai-completions.lazy`).
- Nebius Token Factory requires the compat block:
  `supportsDeveloperRole: false`, `supportsStore: false`,
  `maxTokensField: 'max_tokens'` — TF 422s the OpenAI `developer` role.
  Reference construction (model route + pricing fields) is in the
  adjudication evidence; port into `src/agents/providers.ts` in P05.

## Cloudflare target

- `npx @flue/cli@<pin> init --target cloudflare` generates: `flue.config.ts`,
  `src/app.ts` (route map — every route mounted explicitly),
  `src/cloudflare.ts` (Worker-level exports; **never a `fetch`**), agent
  modules, `vite.config.ts` (`flue()` before `cloudflare({config:
  flueWorkerConfig()})`), `wrangler.jsonc`.
- Every agent identity generates a **Durable Object class `Flue<Name>Agent`**
  and needs a wrangler **migration entry**; migrations are append-only —
  append a new `{tag, new_sqlite_classes}` entry per added agent.
- `src/cloudflare.ts` named exports collide with generated classes → rename
  error at build; its default export must be an object of non-HTTP handlers.
- The generated Worker entry calls **your Hono `app.fetch(request, env,
  ctx)`** — one fetch entry; application routes and agents compose there.
- The flue vite plugin adds CORS-ish headers
  (`Access-Control-Allow-Credentials`, `Access-Control-Expose-Headers:
  Stream-Next-Offset, Stream-Up-To-Date, Location`) to responses; harmless,
  expected.
- `flueWorkerConfig()` must be called after `flue()` in the same vite config;
  the sibling plugin owns the wrangler config end to end.

## Static assets composition (P00-established)

- Static assets are plain wrangler `assets` config, honored through the vite
  build: `directory`, `binding`, `not_found_handling`, `run_worker_first`
  pass through to the generated `dist/<name>/wrangler.json`.
- `run_worker_first` as an array keeps `/api`, `/agents`, `/app` in the
  Worker (JSON 404s, SPA fallback) while the landing tree serves directly.
- Hono gotcha: a **mounted sub-app's `.notFound()` does not fire** for
  unmatched paths under its mount — handle the JSON 404 on the parent app.
- `vite build` outputs the worker to `dist/<name>/` and the client to
  `dist/client/`; `bun run compose:assets` merges the Astro landing + SPA
  (collision-checked, manifest at `apps/app/dist/composition-manifest.json`).
- `vite preview` runs the real workerd locally — use it as the routing test
  harness (no deploy). Known limit (flue 2.2.2): agent **dispatch** through
  the DO router under `vite preview` fails with
  `TypeError: this.runtime.startActiveSpan is not a function` — mounting and
  route composition are provable there (non-404 + structured Flue error
  body), but agents do not actually execute. Execute agents via
  `bunx flue run <module> --message ...` or `bun run dev`; P05 must not
  classify preview-harness agent responses as run evidence.

## @flue/react transport (adopt in P06)

- `useFlueAgent({ url })` → `messages` (typed parts: text / reasoning /
  `data-*` / `dynamic-tool` / file), `status`
  (idle|connecting|submitted|streaming|error), `historyReady`, `error`,
  `failedSends` (retained optimistic messages with retry),
  `settlements` (submissionId → outcome), `refresh()`.
- `sendMessage(message: string, options?)` takes a **plain string** —
  passing a message object 400s (`invalid_request`). Options pass through
  idempotencyKey / initialData / uid / signal / images / documents.
- Tool-banner grammar maps 1:1 onto `dynamic-tool` part states
  (queued → working → output-available | output-error).

## Sandbox/runtime behavior (for P03/P04/P05 design)

- Crash recovery in the DO mode is real: `onStart` → drain unsettled
  submissions (30s lease + 15s scan, same-submissionId replacement) — zero
  application recovery code, LIVE VERIFIED after whole-runtime SIGKILL.
- Cross-process abort intent (`abort_requested_at`) is durable and enforced;
  observed 5.3–6.6s to terminal-aborted with resurrection blocked. In-flight
  tool cancellation propagates a signal to async adapters.
- Neither Flue nor any framework gives exactly-once external effects:
  interrupted remote work re-runs; keyed/idempotent reconciliation is
  application policy (P03).
- Model coordinators degrade into hallucinated progress when tools are
  blocked — budget caps + completion gates + machine-checked acceptance are
  mandatory (observed live, twice).

## Toolchain notes (local verification)

- `bun test` sets no working directory magic: spawn `vite preview` with an
  explicit `cwd`; preview binds `localhost` (IPv6) by default — pass
  `--host 127.0.0.1` when the harness fetches IPv4.
- `Bun.pid` is `undefined` under `bun test` (bun 1.4.0) — use `process.pid`.
- bun test kills dangling spawned children at exit via the process group —
  do not put the server in the test's group expectation path; clean up by
  **listening** socket (`lsof -ti -sTCP:LISTEN tcp:PORT`; without `-sTCP:
  LISTEN` lsof also returns the test's own client sockets and you kill the
  runner).
- Hono sub-app `notFound` does not fire on mounts (see above); valibot
  schemas have no `.parse` methods — use standalone `v.parse(schema, value)`;
  `v.isoTimestamp()` accepts millisecond-precision UTC, `v.isoDateTime()`
  does not.
