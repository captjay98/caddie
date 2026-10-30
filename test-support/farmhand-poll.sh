#!/usr/bin/env bash
# Read-only snapshot of the Farmhand build loop state from local D1.
set -euo pipefail
cd "$(dirname "$0")/../apps/app"
DB=$(ls -t .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite | head -1)
RUN='run_506d61ece6d7ca3a12fdd9a41a281960'
PROJ='proj_506d61ece6d7ca3a12fdd9a41a281960'
echo "===== $(date '+%H:%M:%S') ====="
sqlite3 "file:$DB?immutable=1" <<SQL
.mode line
select phase, substr(detail,1,160) as detail, datetime(updatedAt) as updated from build_workflows where projectId='$PROJ';
.mode table
select position pos, featureId, status, attempts, testsPassed from build_features where runId='$RUN' order by position;
select featureId, failures, state from build_repair_issues where runId='$RUN';
select substr(a.modelRouteId,1,28) route, datetime(a.createdAt) at from build_repair_attempts a join build_repair_issues i on a.issueId=i.id where i.runId='$RUN' order by a.createdAt;
SQL
