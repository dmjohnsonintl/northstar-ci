#!/usr/bin/env bash
# Real engine: the Claude Code CLI, headless. Reads the failing-test log, edits
# the source in the workdir to make tests pass, and commits — no GitHub App, no
# OIDC, just an API key. Contract (same as all engines): runs on the fix branch,
# reads NS_FIX_LOG, leaves a commit. Requires ANTHROPIC_API_KEY.
set -euo pipefail
: "${ANTHROPIC_API_KEY:?claude-code engine requires ANTHROPIC_API_KEY}"

# Read the failing-test log from the repo root BEFORE cd'ing into the workdir
# (NS_FIX_LOG is repo-root-relative).
LOG_CONTENT="$(cat "${NS_FIX_LOG:?}" 2>/dev/null || echo '(no failing-test log captured)')"

# Layer-aware framing (advisory). System/E2E failures fail differently from unit
# bugs — a selector, a wait/timing issue, or a real product regression.
LAYER="${NS_FIX_LAYER:-unit}"
if [ "$LAYER" = "system" ]; then
  LAYER_NOTE="These are END-TO-END / system tests (e.g. Playwright). The failure may be a broken selector, a wait/timing issue, or a genuine product regression — investigate the app behavior, not just a single function."
else
  LAYER_NOTE=""
fi

cd "${NS_FIX_WORKDIR:?}"

# Install the CLI (idempotent).
npm install -g @anthropic-ai/claude-code >/dev/null 2>&1

PROMPT="The test suite in this project is failing. Here is the failing-test output:

${LOG_CONTENT}

${LAYER_NOTE}

Fix the SOURCE code in this directory so the tests pass. Make the minimal change.
Do NOT weaken, skip, delete, or edit the tests to make them pass. Do NOT edit
package.json or config files. Only change source code to fix the underlying bug."

echo "[northstar] fixing at layer: $LAYER"

# Headless, auto-approve edits, JSON output so we can record token/cost. --bare
# skips local config. Edits still apply (output format is orthogonal to tool use).
OUT="$(claude -p --bare --output-format json --permission-mode acceptEdits "$PROMPT" 2>/dev/null || true)"

# Write the usage record blob for the fix-agent to merge context onto. Defensive:
# empty/garbage output -> null-cost blob (never blocks the fix on cost accounting).
if [ -n "${NS_FIX_RECORD:-}" ]; then
  # Guard the cd so a resolution failure can't abort the script under `set -e`
  # BEFORE the commit block below — the fix must never be blocked by cost accounting.
  LIB_DIR="$(cd "$(dirname "$0")/../../lib" 2>/dev/null && pwd)" || LIB_DIR=""
  if [ -n "$LIB_DIR" ] && printf '%s' "$OUT" | node "$LIB_DIR/engine-usage.js" > "$NS_FIX_RECORD" 2>/dev/null; then :; else
    printf '{"engine":"claude-code","costUsd":null,"tokens":null,"model":null,"numTurns":null}' > "$NS_FIX_RECORD"
  fi
fi

git config user.name "northstar[bot]"
git config user.email "northstar@users.noreply.github.com"
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -qm "fix(northstar): claude-code engine fix for failing tests"
  echo "[northstar] claude-code engine committed a fix"
else
  echo "[northstar] claude-code engine produced no changes" >&2
  exit 1
fi
