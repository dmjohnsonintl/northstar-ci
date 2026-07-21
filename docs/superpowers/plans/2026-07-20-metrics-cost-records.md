# Metrics Cost Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture per-run engine token/cost into a durable record stream and render the dashboard's last `—` (cost) as a real Cost section.

**Architecture:** Each engine writes a usage blob to `$NS_FIX_RECORD` (claude-code parses `--output-format json`; stub writes honest nulls). The `fix-agent` action merges run context and persists `records/<runId>-<job>.json` to a dedicated `northstar-metrics` orphan branch via an isolated worktree + rebase-retry push (loud but never fails the fix). A pure `costFromRecords` read-model aggregates the records the metrics workflow fetches from that branch, and `renderDashboard` shows the Cost section.

**Tech Stack:** Node built-in test runner (`node:test`) for pure lib logic, bash + `jq` + git in composite actions and the metrics workflow, the `claude` CLI (`--output-format json`).

## Global Constraints

- **Canonical repo:** `dmjohnsonintl/northstar-ci` (local `/Users/davidjohnson/Documents/Claude/Projects/northstar-ci`). All work here.
- **Full public action refs inside reusable workflows:** actions called from `northstar-pipeline.yml` MUST use `dmjohnsonintl/northstar-ci/actions/<name>@v0`. Demo *callers* in this repo use local `uses: ./.github/workflows/...`.
- **`v0` moves as the slice completes:** after pushing `main`, `git tag -f v0 && git push -f origin v0`. Remote `main` may be ahead (scheduled `metricsdemo`/promote bot commits) — `git pull --rebase origin main` before pushing; verify `git rev-parse v0 == HEAD` after.
- **Cost accounting must NEVER gate a fix:** the metrics-record persist step is **loud but non-fatal** — a push failure emits `::error::`/`::warning::` annotations but the step ends `exit 0`. (Composite-action steps do NOT support `continue-on-error`, so non-fatality is handled inside the shell.)
- **Read-model determinism:** `lib/metrics.js` never calls `Date.now()`; `now` is always injected. Record *creation* in CI may stamp real time (`date -u +%FT%TZ`) — that is event data, not read-model rendering.
- **Honest nulls, never fabricated zeros:** absent cost renders `—`.
- **Bot identity for commits actions make at runtime:** `git config user.name "northstar[bot]"` / `user.email "northstar@users.noreply.github.com"`.
- **Run the full unit suite:** `npm test` (globs `lib/*.test.js adapters/contract.test.js adapters/*/*.test.js engine/*.test.js`). Python contract cases skipped locally is normal.
- **Record file path:** `records/<GITHUB_RUN_ID>-<GITHUB_JOB>.json` on the `northstar-metrics` branch (one file per run+job → no content conflicts).

---

### Task 1: Engine usage capture (`lib/engine-usage.js` + both engines write `$NS_FIX_RECORD`)

Extract a pure, unit-tested parser for the `claude -p --output-format json` envelope, and have both engines write a usage blob.

**Files:**
- Create: `lib/engine-usage.js`
- Create: `lib/engine-usage.test.js`
- Modify: `engine/claude-code/fix.sh`
- Modify: `engine/stub/fix.sh`

**Interfaces:**
- Consumes: nothing new.
- Produces: `parseClaudeUsage(envelope) -> {engine:'claude-code', costUsd:number|null, tokens:{input,output,cacheRead}|null, model:string|null, numTurns:number|null}` (exported + a stdin→stdout CLI). Both engines write this blob shape to `$NS_FIX_RECORD`. Task 2 merges context onto it.

- [ ] **Step 1: Write the failing test** `lib/engine-usage.test.js`:

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseClaudeUsage } = require('./engine-usage');

// A captured `claude -p --output-format json` success envelope (shape only; no CLI).
const ENVELOPE = JSON.stringify({
  type: 'result', subtype: 'success',
  total_cost_usd: 0.0123,
  usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 8000 },
  model: 'claude-opus-4-8', num_turns: 3, result: 'done',
});

test('parseClaudeUsage extracts cost, tokens, model, turns', () => {
  const u = parseClaudeUsage(ENVELOPE);
  assert.equal(u.engine, 'claude-code');
  assert.equal(u.costUsd, 0.0123);
  assert.deepEqual(u.tokens, { input: 1200, output: 340, cacheRead: 8000 });
  assert.equal(u.model, 'claude-opus-4-8');
  assert.equal(u.numTurns, 3);
});

test('parseClaudeUsage returns nulls for malformed/empty input (never fabricates cost)', () => {
  for (const bad of ['', 'not json', '{}', JSON.stringify({ result: 'x' })]) {
    const u = parseClaudeUsage(bad);
    assert.equal(u.engine, 'claude-code');
    assert.equal(u.costUsd, null);
    assert.equal(u.tokens, null);
    assert.equal(u.model, null);
    assert.equal(u.numTurns, null);
  }
});

test('parseClaudeUsage keeps partial tokens when some fields present', () => {
  const u = parseClaudeUsage(JSON.stringify({ total_cost_usd: 1, usage: { input_tokens: 5 } }));
  assert.equal(u.costUsd, 1);
  assert.deepEqual(u.tokens, { input: 5, output: null, cacheRead: null });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci && node --test lib/engine-usage.test.js`
Expected: FAIL — `Cannot find module './engine-usage'`.

- [ ] **Step 3: Write `lib/engine-usage.js`:**

```javascript
'use strict';
// Parse the `claude -p --output-format json` result envelope into the usage blob
// Northstar records. Pure + defensive: any missing/malformed field yields null
// (cost is observability — never fabricate it).

function num(v) {
  // Only accept real numbers — never coerce arrays/booleans/whitespace strings
  // into a fabricated cost (Number([5])===5, Number(true)===1, Number('  ')===0).
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseClaudeUsage(envelope) {
  let o;
  try {
    o = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
  } catch {
    o = null;
  }
  o = o && typeof o === 'object' ? o : {};
  const u = o.usage && typeof o.usage === 'object' ? o.usage : {};
  const anyTok =
    u.input_tokens != null || u.output_tokens != null || u.cache_read_input_tokens != null;
  return {
    engine: 'claude-code',
    costUsd: num(o.total_cost_usd),
    tokens: anyTok
      ? { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens) }
      : null,
    model: typeof o.model === 'string' ? o.model : null,
    numTurns: num(o.num_turns),
  };
}

module.exports = { parseClaudeUsage };

// CLI: read the envelope from stdin, write the blob JSON to stdout.
if (require.main === module) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => process.stdout.write(JSON.stringify(parseClaudeUsage(chunks.join('')))));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test lib/engine-usage.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Make the claude-code engine capture usage.** In `engine/claude-code/fix.sh`, replace the single invocation line:

```bash
# Headless, reproducible (--bare skips local config), auto-approve edits.
claude -p --bare --permission-mode acceptEdits "$PROMPT" || true
```

with (capture the JSON envelope, still apply edits, write the usage blob defensively):

```bash
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
```

(The subsequent `git status --porcelain` commit logic in the script is unchanged — the edits made during the run are committed exactly as before.)

- [ ] **Step 6: Make the stub engine write a null-cost record.** In `engine/stub/fix.sh`, before the final `echo "[northstar] stub engine committed a fix"` line, add:

```bash
# Honest null-cost record (the stub spends nothing) so the full record path can
# be proven in CI without API spend.
if [ -n "${NS_FIX_RECORD:-}" ]; then
  printf '{"engine":"stub","costUsd":null,"tokens":null,"model":"stub","numTurns":null}' > "$NS_FIX_RECORD"
fi
```

- [ ] **Step 7: Verify both engines write the blob (stub end-to-end; claude-code shape via the parser CLI).**

Run:
```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci
# stub writes a null-cost blob:
D=$(mktemp -d); git -C "$D" init -q; echo x > "$D/f"; git -C "$D" add -A; git -C "$D" commit -qm init
REC="$(mktemp)"; NS_FIX_WORKDIR="$D" NS_FIX_LOG=/dev/null NS_FIX_RECORD="$REC" GITHUB_RUN_ID=test bash engine/stub/fix.sh >/dev/null
echo "stub record:"; cat "$REC"; echo
# claude-code parse path (no CLI/spend — feed a captured envelope through the same node helper the engine uses):
echo '{"total_cost_usd":0.02,"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0},"model":"claude-opus-4-8","num_turns":2}' | node lib/engine-usage.js; echo
rm -rf "$D" "$REC"
```
Expected: the stub record is `{"engine":"stub","costUsd":null,...,"model":"stub",...}`; the parser prints `{"engine":"claude-code","costUsd":0.02,"tokens":{"input":10,"output":5,"cacheRead":0},...}`.

- [ ] **Step 8: Run the full suite + commit.**

```bash
npm test
git add lib/engine-usage.js lib/engine-usage.test.js engine/claude-code/fix.sh engine/stub/fix.sh
git commit -m "feat(engine): capture per-run token/cost to \$NS_FIX_RECORD

claude-code runs with --output-format json and parses total_cost_usd/usage via
a pure, unit-tested lib/engine-usage.js; stub writes an honest null-cost record
so the record path proves free in CI. Defensive: malformed output -> null cost,
never blocks a fix.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

**NOTE for the reviewer/controller:** the `claude -p --bare --output-format json --permission-mode acceptEdits` composition can't be locally verified without API spend. It is defensive (empty output → null record; edits still apply). Validate the real-engine cost numbers on the next §12.1 nightly-canary run; this slice proves the *plumbing* on the stub.

---

### Task 2: `fix-agent` persists the record to the `northstar-metrics` branch

Merge run context onto the engine blob and push `records/<runId>-<job>.json` to a dedicated orphan branch in an isolated worktree — loud but never failing the fix. Thread a `zone` input so records carry the routed zone.

**Files:**
- Modify: `actions/fix-agent/action.yml`
- Modify: `.github/workflows/northstar-pipeline.yml` (pass `zone` to fix-agent in the `fix` and `fix-system` jobs)

**Interfaces:**
- Consumes: `lib/engine-usage.js` blob at `$NS_FIX_RECORD` (Task 1).
- Produces: a record on the `northstar-metrics` branch with fields `{engine, costUsd, tokens, model, numTurns, runId, workflow, job, layer, zone, outcome, createdAt}`. Task 3's `costFromRecords` consumes `createdAt`, `costUsd`, `tokens`, `layer`.

- [ ] **Step 1: Add a `zone` input to the action.** In `actions/fix-agent/action.yml`, add to `inputs:` (after `layer`):

```yaml
  zone:
    description: 'Routed zone for this fix (recorded in metrics). Empty = repo.'
    default: ''
```

- [ ] **Step 2: Pass `NS_FIX_RECORD` to both engine steps.** Add `NS_FIX_RECORD: ${{ runner.temp }}/ns-engine-record.json` to the `env:` of BOTH the `Engine (stub)` and `Engine (claude-code)` steps. After the edit the stub step env is:

```yaml
      env:
        NS_FIX_WORKDIR: ${{ inputs.workdir }}
        NS_FIX_LOG: ${{ inputs.failing-log }}
        NS_FIX_LAYER: ${{ inputs.layer }}
        NS_FIX_RECORD: ${{ runner.temp }}/ns-engine-record.json
```

and the claude-code step env keeps `ANTHROPIC_API_KEY` and adds the same `NS_FIX_RECORD` line.

- [ ] **Step 3: Capture the fix outcome.** Give the rerun step `id: rerun` and emit an `outcome` output. Change the step header line `- name: Re-run tests, then open a PR or escalate` to add the id:

```yaml
    - name: Re-run tests, then open a PR or escalate
      id: rerun
```

Then inside its `run:` block, in the PASS branch add after `echo "[northstar] green after fix → PR opened on $BRANCH"`:

```bash
          echo "outcome=fixed" >> "$GITHUB_OUTPUT"
```

and in the `else` (escalate) branch add after `echo "[northstar] still red after one attempt → escalated to a human"`:

```bash
          echo "outcome=escalated" >> "$GITHUB_OUTPUT"
```

- [ ] **Step 4: Add the persist step.** Append this as the LAST step of the composite action (after the rerun step):

```yaml
    - name: Persist metrics record (loud but never fails the fix)
      if: ${{ always() }}
      shell: bash
      env:
        ENGINE: ${{ inputs.engine }}
        LAYER: ${{ inputs.layer }}
        ZONE: ${{ inputs.zone }}
        OUTCOME: ${{ steps.rerun.outputs.outcome }}
        RUN_ID: ${{ github.run_id }}
        JOB: ${{ github.job }}
        WORKFLOW: ${{ github.workflow }}
        BLOB: ${{ runner.temp }}/ns-engine-record.json
        WT: ${{ runner.temp }}/ns-metrics-wt
      run: |
        set -uo pipefail
        # Fall back to a null-cost blob if the engine didn't write one.
        [ -f "$BLOB" ] || printf '{"engine":"%s","costUsd":null,"tokens":null,"model":null,"numTurns":null}' "$ENGINE" > "$BLOB"
        CREATED="$(date -u +%FT%TZ)"
        REC="${BLOB%.json}-full.json"
        jq \
          --arg runId "$RUN_ID" --arg workflow "$WORKFLOW" --arg job "$JOB" \
          --arg layer "${LAYER:-unit}" --arg zone "${ZONE:-repo}" \
          --arg outcome "${OUTCOME:-unknown}" --arg createdAt "$CREATED" \
          '. + {runId:$runId, workflow:$workflow, job:$job, layer:$layer, zone:$zone, outcome:$outcome, createdAt:$createdAt}' \
          "$BLOB" > "$REC"

        git config user.name "northstar[bot]"
        git config user.email "northstar@users.noreply.github.com"
        rm -rf "$WT"
        git fetch origin northstar-metrics 2>/dev/null || true
        if git rev-parse --verify origin/northstar-metrics >/dev/null 2>&1; then
          # --detach avoids git's DWIM auto-branch-creation ambiguity, then make
          # a clean local branch at the remote tip to push from.
          git worktree add --detach "$WT" origin/northstar-metrics >/dev/null 2>&1 || { echo "::warning::metrics worktree add failed"; exit 0; }
          git -C "$WT" switch -C northstar-metrics origin/northstar-metrics >/dev/null 2>&1 || true
        else
          # First record ever: create the orphan branch in the worktree.
          git worktree add --detach "$WT" >/dev/null 2>&1 || { echo "::warning::metrics worktree add failed"; exit 0; }
          git -C "$WT" checkout --orphan northstar-metrics >/dev/null 2>&1 || true
          git -C "$WT" rm -rf . >/dev/null 2>&1 || true
        fi
        mkdir -p "$WT/records"
        cp "$REC" "$WT/records/${RUN_ID}-${JOB}.json"
        git -C "$WT" add "records/${RUN_ID}-${JOB}.json"
        git -C "$WT" commit -qm "chore(metrics): record for run ${RUN_ID} (${JOB})" || echo "no record change"
        # Rebase-retry push; LOUD (annotations) but NON-FATAL (cost never fails a fix).
        pushed=false
        for attempt in 1 2 3; do
          git -C "$WT" pull --rebase --autostash origin northstar-metrics >/dev/null 2>&1 || true
          if git -C "$WT" push origin northstar-metrics >/dev/null 2>&1; then pushed=true; break; fi
          echo "::warning::metrics record push attempt $attempt failed — retrying"
        done
        [ "$pushed" = true ] || echo "::error::could not push metrics record for run ${RUN_ID} after 3 attempts (fix is unaffected)"
        git worktree remove --force "$WT" >/dev/null 2>&1 || true
        exit 0
```

- [ ] **Step 5: Pass `zone` from the pipeline fix jobs.** In `.github/workflows/northstar-pipeline.yml`, the `fix` job's `fix-agent` step: add `zone: ${{ steps.zone.outputs.name }}` to its `with:` block. Do the same in the `fix-system` job's `fix-agent (layer=system)` step. (Both jobs already compute `steps.zone.outputs.name`.)

- [ ] **Step 6: Lint the two YAML files.**

Run:
```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci
python3 -c "import yaml; yaml.safe_load(open('actions/fix-agent/action.yml')); yaml.safe_load(open('.github/workflows/northstar-pipeline.yml')); print('YAML OK')"
```
Expected: `YAML OK`. (If pyyaml is unavailable, say so and confirm structure by reading; the CI demo in Task 5 is the runtime proof.)

- [ ] **Step 7: Commit.**

```bash
git add actions/fix-agent/action.yml .github/workflows/northstar-pipeline.yml
git commit -m "feat(fix-agent): persist per-run cost record to the northstar-metrics branch

After a fix, merge run context (runId/workflow/job/layer/zone/outcome/createdAt)
onto the engine usage blob and push records/<runId>-<job>.json to a dedicated
orphan branch in an isolated worktree with rebase-retry. Loud but non-fatal: a
metrics-write failure never fails the fix. Pipeline fix/fix-system jobs now pass
the routed zone.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `costFromRecords` read-model + dashboard Cost section

**Files:**
- Modify: `lib/metrics.js`
- Modify: `lib/metrics.test.js`

**Interfaces:**
- Consumes: an array of record objects (Task 2's shape).
- Produces: `costFromRecords(records, {now, sinceDays}) -> {runsTotal, runsWithCost, totalCostUsd, costPerRun, tokens:{input,output,cacheRead}, byLayer}` (exported). `renderDashboard` reads `model.cost`. Task 4's CLI builds `model.cost`.

- [ ] **Step 1: Write the failing tests.** Append to `lib/metrics.test.js`:

```javascript
const { costFromRecords } = require('./metrics');

const REC_NOW = '2026-07-18T00:00:00Z';
const recAgo = (days, over) => ({
  createdAt: new Date(Date.parse(REC_NOW) - days * 86400000).toISOString(),
  ...over,
});

test('costFromRecords sums cost in-window and counts null-cost runs honestly', () => {
  const recs = [
    recAgo(1, { engine: 'claude-code', costUsd: 0.02, tokens: { input: 100, output: 50, cacheRead: 10 }, layer: 'unit' }),
    recAgo(2, { engine: 'claude-code', costUsd: 0.03, tokens: { input: 200, output: 60, cacheRead: 0 }, layer: 'system' }),
    recAgo(3, { engine: 'stub', costUsd: null, tokens: null, layer: 'unit' }),
    recAgo(30, { engine: 'claude-code', costUsd: 9.99, tokens: { input: 1, output: 1, cacheRead: 1 }, layer: 'unit' }), // outside window
  ];
  const c = costFromRecords(recs, { now: REC_NOW, sinceDays: 7 });
  assert.equal(c.runsTotal, 3);       // #4 excluded by window
  assert.equal(c.runsWithCost, 2);    // stub null-cost not counted as cost
  assert.equal(c.totalCostUsd, 0.05);
  assert.equal(c.costPerRun, 0.025);
  assert.deepEqual(c.tokens, { input: 300, output: 110, cacheRead: 10 });
  assert.equal(c.byLayer.unit.runs, 2);
  assert.equal(c.byLayer.unit.costUsd, 0.02);
  assert.equal(c.byLayer.system.costUsd, 0.03);
});

test('costFromRecords returns nulls (renders —) for no records', () => {
  const c = costFromRecords([], { now: REC_NOW });
  assert.equal(c.runsTotal, 0);
  assert.equal(c.totalCostUsd, null);
  assert.equal(c.costPerRun, null);
});

test('costFromRecords requires now', () => {
  assert.throws(() => costFromRecords([], {}), /now/);
});

test('renderDashboard shows the Cost section when records exist', () => {
  const model = {
    rollup: rollup([], { now: REC_NOW }),
    cost: costFromRecords([recAgo(1, { engine: 'claude-code', costUsd: 0.02, tokens: { input: 100, output: 50, cacheRead: 0 }, layer: 'unit' })], { now: REC_NOW, sinceDays: 7 }),
    generatedAt: REC_NOW,
  };
  const md = renderDashboard(model);
  assert.match(md, /## Cost/);
  assert.match(md, /\$0\.0200/);
});

test('renderDashboard Cost section falls back to — with no records', () => {
  const model = { rollup: rollup([], { now: REC_NOW }), cost: costFromRecords([], { now: REC_NOW }), generatedAt: REC_NOW };
  const md = renderDashboard(model);
  assert.match(md, /## Cost/);
  assert.match(md, /No engine cost records yet/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test lib/metrics.test.js`
Expected: FAIL — `costFromRecords is not a function` / no `## Cost`.

- [ ] **Step 3: Add `costFromRecords` to `lib/metrics.js`.** Insert after the `agentHealth` function (before `barFor`):

```javascript
// Cost/usage read-model from per-run engine records (spec §12 cost line). Records
// carry {createdAt, costUsd, tokens:{input,output,cacheRead}, layer}. Null-cost
// records (e.g. the stub engine) count as runs but not cost — honest, never a
// fabricated zero. Pure: `now` injected, never Date.now().
function costFromRecords(records, opts = {}) {
  const now = toMs(opts.now);
  if (!Number.isFinite(now)) throw new Error('costFromRecords: `now` is required (ISO string or ms)');
  const sinceDays = opts.sinceDays || 7;
  const from = now - sinceDays * DAY_MS;
  const round4 = (x) => Math.round(x * 10000) / 10000;

  const inWindow = (records || []).filter((r) => {
    const t = toMs(r && r.createdAt);
    return Number.isFinite(t) && t >= from && t <= now;
  });
  if (!inWindow.length) {
    return { runsTotal: 0, runsWithCost: 0, totalCostUsd: null, costPerRun: null, tokens: { input: null, output: null, cacheRead: null }, byLayer: {} };
  }
  // Strict (typeof-gated) like the engine's num() — never coerce a hand-edited
  // array/boolean/whitespace on the branch into a fabricated cost.
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const withCost = inWindow.filter((r) => isNum(r.costUsd));
  const totalCost = withCost.length ? round4(withCost.reduce((s, r) => s + Number(r.costUsd), 0)) : null;
  const tokSum = (key) => {
    const xs = inWindow.filter((r) => r.tokens && isNum(r.tokens[key]));
    return xs.length ? xs.reduce((s, r) => s + Number(r.tokens[key]), 0) : null;
  };
  const byLayer = {};
  for (const r of inWindow) {
    const L = r.layer || 'unknown';
    const b = (byLayer[L] = byLayer[L] || { runs: 0, _cost: 0, _has: false });
    b.runs += 1;
    if (isNum(r.costUsd)) { b._cost += Number(r.costUsd); b._has = true; }
  }
  for (const L of Object.keys(byLayer)) {
    byLayer[L].costUsd = byLayer[L]._has ? round4(byLayer[L]._cost) : null;
    delete byLayer[L]._cost; delete byLayer[L]._has;
  }
  return {
    runsTotal: inWindow.length,
    runsWithCost: withCost.length,
    totalCostUsd: totalCost,
    costPerRun: totalCost != null && withCost.length ? round4(totalCost / withCost.length) : null,
    tokens: { input: tokSum('input'), output: tokSum('output'), cacheRead: tokSum('cacheRead') },
    byLayer,
  };
}
```

- [ ] **Step 4: Render the Cost section.** In `renderDashboard`, REMOVE the "Not yet wired" block:

```javascript
  lines.push('## Not yet wired');
  lines.push('');
  lines.push('- **Cost (tokens per run/role)** requires engine token instrumentation — shown as `—` above rather than a fabricated zero. CI time, coordination health, and regression growth are now derived from traces.');
  lines.push('');
```

and REPLACE it with:

```javascript
  const cost = model.cost || {};
  const usd = (v) => (v == null ? '—' : `$${Number(v).toFixed(4)}`);
  lines.push('## Cost');
  lines.push('');
  if (!cost.runsTotal) {
    lines.push('- _No engine cost records yet — `stub` fix runs emit null-cost records; real cost appears when `engine: claude-code` runs._');
  } else {
    lines.push(`- **Total (window):** ${usd(cost.totalCostUsd)} across ${cost.runsWithCost}/${cost.runsTotal} fix runs with cost data`);
    lines.push(`- **Per fix run:** ${usd(cost.costPerRun)}`);
    const t = cost.tokens || {};
    lines.push(`- **Tokens:** in ${t.input ?? '—'} · out ${t.output ?? '—'} · cache-read ${t.cacheRead ?? '—'}`);
    const layers = Object.keys(cost.byLayer || {}).sort();
    if (layers.length) lines.push(`- **By layer:** ${layers.map((L) => `${L} ${usd(cost.byLayer[L].costUsd)} (${cost.byLayer[L].runs} runs)`).join(' · ')}`);
  }
  lines.push('');
```

- [ ] **Step 5: Export `costFromRecords`.** In the `module.exports` at the bottom of `lib/metrics.js`, add `costFromRecords,` to the list.

- [ ] **Step 6: Run tests + full suite**

Run: `node --test lib/metrics.test.js && npm test`
Expected: PASS (new cost tests + existing suite; python cases skipped locally).

- [ ] **Step 7: Commit.**

```bash
git add lib/metrics.js lib/metrics.test.js
git commit -m "feat(metrics): costFromRecords read-model + dashboard Cost section

Pure, windowed aggregation of per-run engine cost records (null-cost runs counted
honestly, never a fabricated zero). renderDashboard replaces the 'Not yet wired'
cost placeholder with a real Cost section (total, per-run, tokens, by-layer),
falling back to '—' when there are no records.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Wire records through the CLI, the metrics workflow, and docs

**Files:**
- Modify: `lib/metrics-cli.js`
- Modify: `.github/workflows/northstar-metrics.yml`
- Modify: `docs/observability.md`

**Interfaces:**
- Consumes: `costFromRecords` (Task 3), record files on the `northstar-metrics` branch (Task 2).
- Produces: a dashboard whose Cost section reflects the branch's records.

- [ ] **Step 1: Add `--records` to the CLI.** In `lib/metrics-cli.js`, add `costFromRecords` to the destructured require from `./metrics`:

```javascript
const {
  fromGhRuns,
  rollup,
  coverageSeries,
  agentHealth,
  costFromRecords,
  renderDashboard,
  renderDigest,
} = require('./metrics');
```

Add a records read after the `extra` line (`const extra = readJson(arg('extra'), {});`):

```javascript
const records = readJson(arg('records'), []);
```

And add `cost` to the `model` object (after the `regression:` line):

```javascript
  cost: costFromRecords(records, { now, sinceDays }),
```

- [ ] **Step 2: Gather records in the metrics workflow.** In `.github/workflows/northstar-metrics.yml`, in the `Gather traces` step, after the `extra.json` `jq -n ... > extra.json` block, append:

```bash
          # Engine cost records from the dedicated northstar-metrics branch
          # (git archive → no worktree/index pollution). Absent branch → empty.
          git fetch origin northstar-metrics 2>/dev/null || true
          rm -rf .nsrec && mkdir -p .nsrec
          if git rev-parse --verify origin/northstar-metrics >/dev/null 2>&1; then
            git archive origin/northstar-metrics records 2>/dev/null | tar -x -C .nsrec 2>/dev/null || true
          fi
          if ls .nsrec/records/*.json >/dev/null 2>&1; then
            # Guard: a single corrupt/hand-edited record must not black out the
            # whole dashboard (this step runs under set -euo pipefail).
            jq -s '.' .nsrec/records/*.json > records.json || echo '[]' > records.json
          else
            echo '[]' > records.json
          fi
```

- [ ] **Step 3: Pass `--records` to both render calls.** In the `Render dashboard + digest` step of `northstar-metrics.yml`, add `--records records.json` to BOTH `node lib/metrics-cli.js ...` invocations (the dashboard one and the digest one).

- [ ] **Step 4: Document the metrics branch.** Append to `docs/observability.md`:

```markdown
## Cost & the `northstar-metrics` branch

Fix runs emit a per-run usage record (token/cost) that GitHub run-traces don't
carry. Records live on a dedicated **`northstar-metrics`** orphan branch (one file
per run under `records/`), written by the fix-agent with a rebase-retry push — this
branch holds only metrics data and is **never merged into `main`**. The metrics
workflow reads it (`git archive`) and renders the dashboard's **Cost** section.

Runs on the `stub` engine emit honest **null-cost** records (the stub spends
nothing), so the pipeline is provable without API spend; real dollar/token figures
appear when a consumer sets `engine: claude-code`.
```

- [ ] **Step 5: Lint the workflow YAML.**

Run:
```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/northstar-metrics.yml')); print('YAML OK')"
```
Expected: `YAML OK`.

- [ ] **Step 6: Smoke-test the CLI end-to-end with a sample records file (local, no CI).**

Run:
```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci
printf '[{"createdAt":"%s","engine":"claude-code","costUsd":0.02,"tokens":{"input":100,"output":50,"cacheRead":0},"layer":"unit"}]' "$(date -u +%FT%TZ)" > /tmp/recs.json
node lib/metrics-cli.js --runs /dev/null --records /tmp/recs.json --now "$(date -u +%FT%TZ)" --since 7 --mode dashboard | grep -A5 '## Cost'
rm -f /tmp/recs.json
```
Expected: a `## Cost` section showing `$0.0200 across 1/1 fix runs`.

- [ ] **Step 7: Commit.**

```bash
git add lib/metrics-cli.js .github/workflows/northstar-metrics.yml docs/observability.md
git commit -m "feat(metrics): wire cost records through the CLI, workflow, and docs

metrics-cli accepts --records; northstar-metrics.yml gathers records from the
northstar-metrics branch via git archive and renders the Cost section. Documents
the dedicated metrics branch.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Prove the full path in CI (stub record → branch → dashboard) + verify

**Files:** none (verification task). Uses existing `fixdemo.yml` (writes a record) and `metricsdemo.yml` (renders it).

**Interfaces:** consumes everything from Tasks 1–4.

- [ ] **Step 1: Controller pushes + re-tags v0.** (Done by the controller at the push checkpoint, with user consent.)

```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci
git pull --rebase origin main
git push origin main
git tag -f v0 && git push -f origin v0
git rev-parse --short HEAD v0   # must match
```

- [ ] **Step 2: Dispatch `fixdemo` — its stub fix job writes a null-cost record to `northstar-metrics`.**

```bash
gh workflow run fixdemo.yml --ref main
sleep 20
gh run watch "$(gh run list --workflow=fixdemo.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
```
Expected: success. The fix job runs the stub engine and its "Persist metrics record" step pushes a record.

- [ ] **Step 3: Verify the record landed on the branch.**

```bash
git fetch origin northstar-metrics
echo "=== record files ===" && git ls-tree -r --name-only origin/northstar-metrics -- records/
echo "=== a record's content ===" && git show "origin/northstar-metrics:$(git ls-tree -r --name-only origin/northstar-metrics -- records/ | head -1)"
```
Expected: at least one `records/<runId>-fix.json`; its content has `"engine":"stub"`, `"costUsd":null`, and context fields (`runId`, `layer`, `zone`, `outcome`, `createdAt`).

- [ ] **Step 4: Dispatch `metricsdemo` — it renders the Cost section from the record.**

```bash
gh workflow run metricsdemo.yml --ref main
sleep 20
gh run watch "$(gh run list --workflow=metricsdemo.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
```
Expected: success.

- [ ] **Step 5: Verify the dashboard shows the Cost section.**

```bash
git fetch origin main -q
git show origin/main:docs/northstar-status.md | grep -A6 '## Cost'
```
Expected: a `## Cost` section reflecting the fix run(s) — e.g. "across 0/N fix runs with cost data" (0 with cost because the stub emits null cost) rather than the old "Not yet wired" placeholder.

- [ ] **Step 6: Reconcile local (the demos committed to main as the bot).**

```bash
git pull --rebase origin main
git rev-parse --short v0 origin/main   # v0 is the code tag; bot commits sit above it — expected
```

---

## Acceptance criteria (maps to the spec)

1. **Engine capture** — `lib/engine-usage.js` parses `--output-format json` (unit-tested via a captured envelope, no CLI); claude-code writes real cost, stub writes honest nulls (Task 1).
2. **Durable record** — fix/fix-system persist `records/<runId>-<job>.json` to `northstar-metrics` (created if absent) via an isolated worktree + rebase-retry; loud but never fails the fix (Task 2). Proven: Task 5 Step 3.
3. **Pure read-model** — `costFromRecords` windows records, counts null-cost runs honestly, splits by layer, empty→`—` (Task 3 tests).
4. **Rendered + wired** — `renderDashboard` Cost section; `metrics-cli --records`; `northstar-metrics.yml` gathers from the branch (Tasks 3–4).
5. **CI proof, no spend** — a stub-engine fix writes a null-cost record and the dashboard's Cost section reflects it (Task 5).
6. **No regression** — other dashboard signals unchanged; the metrics-write never fails a fix.
