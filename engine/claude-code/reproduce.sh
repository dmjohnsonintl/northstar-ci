#!/usr/bin/env bash
# Reproduce engine (Claude Code CLI): read a bug report and write a NEW test that
# FAILS because of the bug — reproduction precedes any fix. Commits the test.
# Contract: NS_FIX_WORKDIR, NS_BUG_TITLE, NS_BUG_BODY. Requires ANTHROPIC_API_KEY.
set -euo pipefail
: "${ANTHROPIC_API_KEY:?reproduce engine requires ANTHROPIC_API_KEY}"
cd "${NS_FIX_WORKDIR:?}"
npm install -g @anthropic-ai/claude-code >/dev/null 2>&1

PROMPT="A user filed this bug report:

Title: ${NS_BUG_TITLE:-(none)}
Body:
${NS_BUG_BODY:-(none)}

Write a NEW test that FAILS because of this bug — it should assert the correct
expected behavior, which the current code does NOT satisfy. Add it as a new test
file matching this project's existing test framework and style. Do NOT fix the bug
and do NOT modify existing source or tests — only ADD a new failing test that
reproduces the reported behavior. Keep it minimal and focused on the one bug."

claude -p --bare --permission-mode acceptEdits "$PROMPT" || true

git config user.name "northstar[bot]"
git config user.email "northstar@users.noreply.github.com"
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -qm "test(northstar): reproduce reported bug with a failing test"
  echo "[northstar] reproduce engine committed a failing test"
else
  echo "[northstar] reproduce engine produced no test" >&2
  exit 1
fi
