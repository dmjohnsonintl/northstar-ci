#!/usr/bin/env bash
# Reproduce engine (stub): deterministically write a FAILING test so the bug-intake
# flow can be exercised without an LLM. The test passes once the stub FIX engine
# drops its marker, so reproduce → (fails) → fix → (passes) works end to end.
# Contract: NS_FIX_WORKDIR, NS_BUG_TITLE, NS_BUG_BODY.
set -euo pipefail
cd "${NS_FIX_WORKDIR:?}"
git config user.name "northstar[bot]" 2>/dev/null || true
git config user.email "northstar@users.noreply.github.com" 2>/dev/null || true
cat > northstar_repro.test.js <<'JS'
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
// Reproduces the reported bug: fails until the fix marker is applied.
test('northstar-stub: reported bug is fixed', () => {
  assert.ok(fs.existsSync('northstar-stub-fix.txt'), 'bug not yet fixed');
});
JS
git add northstar_repro.test.js
git commit -qm "test(northstar-stub): reproduce reported bug with a failing test"
echo "[northstar] stub reproduce engine committed a failing test"
