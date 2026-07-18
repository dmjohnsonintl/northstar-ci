#!/usr/bin/env bash
# Run the JS/TS test suite; exit with the test command's real exit code.
set -uo pipefail
WORKDIR="${NS_WORKDIR:-.}"
TEST_CMD="${NS_TEST_CMD:-npm run test:ci}"
cd "$WORKDIR"
mkdir -p artifacts
set -o pipefail
eval "$TEST_CMD" 2>&1 | tee artifacts/test.log
exit "${PIPESTATUS[0]}"
