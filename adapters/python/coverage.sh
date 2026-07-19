#!/usr/bin/env bash
# Python adapter: run pytest under coverage.py, emit coverage.json, normalize it
# to the Istanbul json-summary shape the gate reads, and print `summary=<path>`.
set -uo pipefail
WORKDIR="${NS_WORKDIR:-.}"
COV_CMD="${NS_COV_CMD:-coverage run -m pytest && coverage json -o coverage.json}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$WORKDIR"
mkdir -p artifacts
set -o pipefail
eval "$COV_CMD" 2>&1 | tee artifacts/coverage.log
STATUS="${PIPESTATUS[0]}"
if [ "$STATUS" -ne 0 ]; then
  echo "::error::coverage command failed (exit $STATUS)" >&2
  exit "$STATUS"
fi
if [ ! -f coverage.json ]; then
  echo "::error::coverage.json not found at $WORKDIR/coverage.json" >&2
  exit 1
fi
# coverage.py json -> Istanbul-shaped coverage-summary.json (language-agnostic gate input)
node "$HERE/../../lib/normalize-cli.js" --in coverage.json --out coverage-summary.json
echo "summary=$WORKDIR/coverage-summary.json"
