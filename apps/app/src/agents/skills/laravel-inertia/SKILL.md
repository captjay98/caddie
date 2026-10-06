# Laravel + Inertia stack skill (P15b v1)

Build and verify Laravel apps with React/Inertia in the sandbox.

## Discipline

- Migrations run ONLY against the disposable test database; a destructive
  migration against any real database requires an explicit owner gate.
- `php artisan test` green before claiming anything; browser proof through
  the private preview, not the dev server.
- The .env in the sandbox is generated per session; credentials never carry
  between sessions or into artifacts.
- Composer lockfile is committed; npm build assets are built at deploy-time
  in the sandbox, never on the host.
- Report exact artisan/npm commands and exit codes.
