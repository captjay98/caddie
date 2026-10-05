# TanStack Start stack skill (P15a v1)

Build and verify full-stack apps with TanStack Start (server functions + SSR).

## Discipline

- Server state lives on the server: use server functions for anything that
  must persist across requests; never fake persistence client-side.
- Run `bun run build` and `bun run start` before claiming anything; a dev
  server is not a production build.
- The private preview must be authenticated; never expose the server function
  endpoints without the preview token.
- Client and server boundaries are explicit: data fetching goes through
  TanStack Router loaders or server functions, not ad-hoc effects.
- Report exact commands and exit codes; the acceptance harness is the truth.
