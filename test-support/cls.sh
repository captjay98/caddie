#!/usr/bin/env bash
# TEMP helper: run a layout-shift probe as the owner without printing secrets.
# Usage: test-support/cls.sh <path> [observeMs]
set -euo pipefail
cd "$(dirname "$0")/.."
OWNER='ZliPZPGyWy15HeTgy5aLnxMRNeTcfj5i'
DB=$(ls -t apps/app/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite | head -1)
export SESSION_TOKEN=$(sqlite3 "file:$DB?immutable=1" "select token from session where userId='$OWNER' and expiresAt > datetime('now') order by updatedAt desc limit 1")
export BETTER_AUTH_SECRET=$(grep -E '^BETTER_AUTH_SECRET=' apps/app/.dev.vars | cut -d= -f2- | tr -d '"')
if [ -z "$SESSION_TOKEN" ]; then echo "no live owner session in local D1" >&2; exit 4; fi
exec bun test-support/layout-shift-probe.ts "$@"
