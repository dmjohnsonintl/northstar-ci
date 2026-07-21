#!/usr/bin/env bash
# Run the suite (RUN_SH) with retry-once flake detection.
#   fail -> pass  = FLAKY  (exit 0, quarantined, not routed to the fix-agent)
#   fail -> fail  = deterministic failure (exit the suite's real nonzero code)
# Reads: RUN_SH (required), RETRIES (default 1). Writes flaky/attempts to
# GITHUB_OUTPUT when set. RUN_SH itself reads NS_WORKDIR/NS_TEST_CMD from the env.
set -uo pipefail
: "${RUN_SH:?RUN_SH required}"
RETRIES="${RETRIES:-1}"
attempt=0
flaky=false
code=0
while :; do
  attempt=$((attempt + 1))
  if bash "$RUN_SH"; then
    [ "$attempt" -gt 1 ] && flaky=true
    code=0
    break
  else
    # Capture the suite's REAL exit code HERE. (An `if` with a false condition
    # and no `else` returns 0, so a bare `code=$?` after `fi` would lose it.)
    code=$?
  fi
  if [ "$attempt" -le "$RETRIES" ]; then
    echo "::warning::suite failed on attempt $attempt — retrying once (possible flake)"
    continue
  fi
  break
done
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "flaky=$flaky" >> "$GITHUB_OUTPUT"
  echo "attempts=$attempt" >> "$GITHUB_OUTPUT"
fi
[ "$flaky" = "true" ] && echo "[northstar] suite is FLAKY (passed on retry after $((attempt - 1)) failure(s)) — quarantining, not routing to fix"
exit "$code"
