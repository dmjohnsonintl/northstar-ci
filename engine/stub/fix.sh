#!/usr/bin/env bash
# Deterministic fake engine for acceptance tests and demos: applies a marker
# patch and commits it on the CURRENT branch (the fix-agent action owns branch
# creation). Lets the failure→fix→PR flow run without an LLM or API key.
# Contract (all engines honor it): runs in NS_FIX_WORKDIR on the fix branch,
# reads NS_FIX_LOG, and leaves a commit behind.
set -euo pipefail
cd "${NS_FIX_WORKDIR:?}"
git config user.name "northstar[bot]" 2>/dev/null || true
git config user.email "northstar@users.noreply.github.com" 2>/dev/null || true
echo "// northstar-stub fix applied for run ${GITHUB_RUN_ID:-local}" > northstar-stub-fix.txt
git add northstar-stub-fix.txt
git commit -qm "fix(northstar-stub): apply known-good patch"
echo "[northstar] stub engine committed a fix"
