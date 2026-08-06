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
#
# stderr is CAPTURED, not discarded. It used to go to /dev/null with `|| true`,
# which made a total engine failure indistinguishable from a successful no-op:
# council-principis run 30976878181 spent 2 seconds, returned 0 tokens and a null
# model, and the run still reported "committed a fix". An engine that cannot run
# must say so.
ERRLOG="$(mktemp)"
set +e
OUT="$(claude -p --bare --output-format json --permission-mode acceptEdits "$PROMPT" 2>"$ERRLOG")"
CLAUDE_RC=$?
set -e

if [ "$CLAUDE_RC" -ne 0 ] || [ -z "${OUT//[[:space:]]/}" ]; then
  echo "::error::claude-code engine failed (exit $CLAUDE_RC). It produced no usable result, so no fix was attempted."
  # BOTH streams. The CLI reports its own errors as JSON on STDOUT and can leave
  # stderr completely empty (council-principis run 30976878181: exit 1, ~2s, no
  # stderr at all), so printing only stderr still yields a blank diagnostic.
  echo "[northstar] --- engine stderr (first 40 lines) ---" >&2
  head -40 "$ERRLOG" >&2 || true
  echo "[northstar] --- engine stdout (first 40 lines) ---" >&2
  printf '%s\n' "$OUT" | head -40 >&2 || true
  rm -f "$ERRLOG"
  exit 1
fi
rm -f "$ERRLOG"

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

# A fix is a MODIFICATION TO TRACKED FILES — not "the working tree is dirty".
# `git status --porcelain` + `git add -A` counted untracked build/test artifacts
# as a fix: run-suite writes <workdir>/artifacts/test.log, and unless the consumer
# happens to gitignore it, the engine committed a log file and announced a fix
# while changing no code at all (council-principis run 30976878181).
#
# `git add -u` stages tracked modifications only, so artifacts can never be swept
# in. Tradeoff: a fix that creates a NEW source file is not detected — but the
# prompt asks for a minimal edit to existing source, and that case fails LOUDLY
# below rather than silently committing junk.
# Tracked modifications are unambiguous — take them all.
CHANGED="$(git diff --name-only)"

# New files are trickier. `git add -A` used to sweep in build/test artifacts and
# report them as a fix, so untracked paths are admitted only when they do NOT look
# like generated output. The denylist is deliberately conservative: a genuinely new
# source file in an unusual location is admitted, and the failure mode for anything
# it wrongly excludes is a LOUD "no changes" below, never a junk commit.
NEW="$(git ls-files --others --exclude-standard \
  | grep -Ev '(^|/)(artifacts|coverage|node_modules|dist|build|__pycache__|\.pytest_cache|\.northstar|\.venv|venv)(/|$)' \
  | grep -Ev '\.(log|lcov)$' || true)"

if [ -n "$CHANGED" ] || [ -n "$NEW" ]; then
  echo "[northstar] engine modified:"
  [ -n "$CHANGED" ] && printf '  %s\n' $CHANGED
  [ -n "$NEW" ] && printf '  %s (new)\n' $NEW
  git add -u
  # Add new files by explicit path, never `-A` — an artifact must not ride along
  # just because it happens to sit next to a real source file.
  if [ -n "$NEW" ]; then printf '%s\n' $NEW | while IFS= read -r f; do git add -- "$f"; done; fi
  git commit -qm "fix(northstar): claude-code engine fix for failing tests"
  echo "[northstar] claude-code engine committed a fix"
else
  echo "::error::claude-code engine ran but produced no source change — nothing to fix with."
  echo "[northstar] claude-code engine produced no changes" >&2
  exit 1
fi
