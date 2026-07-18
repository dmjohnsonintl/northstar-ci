#!/usr/bin/env bash
# Run the JS/TS coverage suite; print `summary=<path>` for coverage-summary.json.
set -uo pipefail
WORKDIR="${NS_WORKDIR:-.}"
COV_CMD="${NS_COV_CMD:-npm run test:coverage}"
cd "$WORKDIR"
mkdir -p artifacts
set -o pipefail
eval "$COV_CMD" 2>&1 | tee artifacts/coverage.log
STATUS="${PIPESTATUS[0]}"
if [ "$STATUS" -ne 0 ]; then
  echo "::error::coverage command failed (exit $STATUS)" >&2
  exit "$STATUS"
fi
SUMMARY="coverage/coverage-summary.json"
if [ ! -f "$SUMMARY" ]; then
  echo "::error::coverage-summary.json not found at $WORKDIR/$SUMMARY" >&2
  exit 1
fi
echo "summary=$WORKDIR/$SUMMARY"
