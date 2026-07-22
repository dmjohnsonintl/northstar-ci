# Nightly Canary + §12.1 Alerting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the real `claude-code` engine against a known-broken fixture on a nightly schedule, feed its green/red verdict into the dashboard, and open deduped alert issues for the four §12.1 drift-detection rules.

**Architecture:** Two new pure modules (`canaryFromRuns` projection in `metrics.js`, `alerts.js` rule engine) with injected time and full unit tests; one thin CLI (`alerts-cli.js`); one reusable canary workflow (canary → assert → cleanup) with a scheduled caller; and edits to `northstar-metrics.yml` to gather claim ages, evaluate alerts, and act on issues. Verdict is read from the canary run's conclusion — no new storage.

**Tech Stack:** Node.js (`node:test`, zero deps), GitHub Actions reusable workflows, `gh` CLI, `jq`, `git archive`.

## Global Constraints

- **Repo:** all work in `dmjohnsonintl/northstar-ci` (`/Users/davidjohnson/Documents/Claude/Projects/northstar-ci`) — NOT the private `Northstar` repo.
- **Purity:** `lib/*.js` read-model code takes `now` as an injected parameter; never call `Date.now()` or `new Date()` argless. Absent data renders `—`/`null`, never a fabricated `0`/`$0`.
- **Node version:** `node --test` on Node 20 (matches `ci.yml`).
- **Test glob:** `package.json` `test` script already globs `lib/*.test.js`; a new `lib/alerts.test.js` is picked up automatically.
- **Cross-repo action refs:** inside reusable workflows, reference actions by full ref `dmjohnsonintl/northstar-ci/actions/<name>@v0` (local `./` refs break cross-repo). Workflow-to-workflow `uses:` inside THIS repo may use `./.github/workflows/<f>.yml`.
- **Consumer permissions:** a reusable workflow requesting a permission the caller didn't grant fails to start with no API error. The canary needs `contents: write` + `pull-requests: write`; document it.
- **`github.run_id` is constant** across the whole run including nested reusable workflows — the fix branch is deterministically `ns/fix/<run_id>`.
- **Commit style:** end messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: `canaryFromRuns` projection + dashboard wiring

**Files:**
- Modify: `lib/metrics.js` (add `canaryFromRuns`, export it)
- Modify: `lib/metrics-cli.js` (populate `agent.canary` from runs)
- Test: `lib/metrics.test.js` (append cases)

**Interfaces:**
- Produces: `canaryFromRuns(runs, { workflowName }) -> 'green' | 'red' | null`
  where `runs` is raw `gh run list --json ...` output (objects with `workflowName`, `conclusion`, `createdAt`).
- Consumes: existing `agentHealth(events)` which already reads `events.canary`; `renderDashboard` already renders `agent.canary` (metrics.js line ~248).

- [ ] **Step 1: Write the failing test**

Append to `lib/metrics.test.js`:

```js
const { canaryFromRuns } = require('./metrics');

test('canaryFromRuns: latest matching run wins, mapped to green/red', () => {
  const runs = [
    { workflowName: 'Northstar canary', conclusion: 'failure', createdAt: ago(3) },
    { workflowName: 'Northstar canary', conclusion: 'success', createdAt: ago(1) }, // latest
    { workflowName: 'Northstar pipeline', conclusion: 'failure', createdAt: ago(0) },
  ];
  assert.equal(canaryFromRuns(runs, { workflowName: 'Northstar canary' }), 'green');
});

test('canaryFromRuns: a red latest run reads red', () => {
  const runs = [
    { workflowName: 'Northstar canary', conclusion: 'success', createdAt: ago(2) },
    { workflowName: 'Northstar canary', conclusion: 'failure', createdAt: ago(1) }, // latest
  ];
  assert.equal(canaryFromRuns(runs, { workflowName: 'Northstar canary' }), 'red');
});

test('canaryFromRuns: no matching run → null (never red)', () => {
  const runs = [{ workflowName: 'Northstar pipeline', conclusion: 'failure', createdAt: ago(1) }];
  assert.equal(canaryFromRuns(runs, { workflowName: 'Northstar canary' }), null);
});

test('canaryFromRuns: latest run still pending → null', () => {
  const runs = [
    { workflowName: 'Northstar canary', conclusion: 'success', createdAt: ago(2) },
    { workflowName: 'Northstar canary', conclusion: '', createdAt: ago(0) }, // pending, newest
  ];
  assert.equal(canaryFromRuns(runs, { workflowName: 'Northstar canary' }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/metrics.test.js`
Expected: FAIL — `canaryFromRuns is not a function`.

- [ ] **Step 3: Implement `canaryFromRuns` in `lib/metrics.js`**

Add after `fromGhRuns` (near line 55), before `rollup`:

```js
// Nightly-canary verdict (spec §12.1): most-recent run of the canary workflow,
// mapped to a health color. Absent/pending → null (unknown), NEVER coerced to red
// — a missing canary is not evidence of a broken model.
function canaryFromRuns(runs, { workflowName } = {}) {
  if (!workflowName) return null;
  const mine = (runs || [])
    .filter((r) => (r.workflowName || r.workflow || r.name) === workflowName)
    .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));
  const latest = mine[0];
  if (!latest) return null;
  const c = (latest.conclusion || '').toLowerCase();
  if (c === 'success') return 'green';
  if (c === 'failure') return 'red';
  return null; // pending / cancelled / other → unknown
}
```

Add `canaryFromRuns` to the `module.exports` object (alongside `fromGhRuns`).

- [ ] **Step 4: Wire it into `lib/metrics-cli.js`**

In `lib/metrics-cli.js`, add `canaryFromRuns` to the destructured require from `./metrics`. Then, where `agentEvents` is read and before building `model`, inject the canary verdict:

```js
const canaryWorkflow = arg('canary-workflow', 'Northstar canary');
// Fold the canary verdict into the agent-health events (agentHealth reads .canary).
agentEvents.canary = canaryFromRuns(runs, { workflowName: canaryWorkflow });
```

(`agent: agentHealth(agentEvents)` in the model then carries it; `renderDashboard` already prints the line.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test lib/metrics.test.js`
Expected: PASS (all four new tests green, existing tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add lib/metrics.js lib/metrics-cli.js lib/metrics.test.js
git commit -m "feat(metrics): canaryFromRuns projection + dashboard canary verdict

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `lib/alerts.js` rule engine + tests

**Files:**
- Create: `lib/alerts.js`
- Test: `lib/alerts.test.js`

**Interfaces:**
- Produces: `evaluateAlerts(model, thresholds, { now }) -> Array<{ rule, state, severity, title, body }>`
  - `model`: `{ canary: 'green'|'red'|null, escalation: { opened, escalations }|null, coverageDeltaFromPrev: number|null, claims: Array<{createdAt, zone}> }`
  - `thresholds`: `{ escalationRate=0.5, coverageDeltaMin=0, claimAgeSeconds=21600 }`
  - `state` is `'firing'` or `'clear'`; rules with missing input are **omitted** from the array.
  - `rule` ∈ `canary | escalation-rate | coverage-trend | claim-starvation`; `severity` ∈ `page | trend`.
- Consumes: `require('./substrate').isStarved(claim, { now, starvationThresholdSeconds })`.

- [ ] **Step 1: Write the failing test**

Create `lib/alerts.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAlerts } = require('./alerts');

const NOW = '2026-07-22T00:00:00Z';
const ago = (s) => new Date(Date.parse(NOW) - s * 1000).toISOString();
const T = { escalationRate: 0.5, coverageDeltaMin: 0, claimAgeSeconds: 21600 };
const find = (out, rule) => out.find((a) => a.rule === rule);

test('canary: red fires (page severity), green clears, null is omitted', () => {
  const red = evaluateAlerts({ canary: 'red' }, T, { now: NOW });
  assert.equal(find(red, 'canary').state, 'firing');
  assert.equal(find(red, 'canary').severity, 'page');

  const green = evaluateAlerts({ canary: 'green' }, T, { now: NOW });
  assert.equal(find(green, 'canary').state, 'clear');

  const none = evaluateAlerts({ canary: null }, T, { now: NOW });
  assert.equal(find(none, 'canary'), undefined);
});

test('escalation-rate: over threshold fires, under clears, missing omitted', () => {
  const hot = evaluateAlerts({ escalation: { opened: 1, escalations: 4 } }, T, { now: NOW }); // 4/5 = 0.8
  assert.equal(find(hot, 'escalation-rate').state, 'firing');

  const ok = evaluateAlerts({ escalation: { opened: 9, escalations: 1 } }, T, { now: NOW }); // 0.1
  assert.equal(find(ok, 'escalation-rate').state, 'clear');

  const missing = evaluateAlerts({ escalation: null }, T, { now: NOW });
  assert.equal(find(missing, 'escalation-rate'), undefined);

  const zeroActivity = evaluateAlerts({ escalation: { opened: 0, escalations: 0 } }, T, { now: NOW });
  assert.equal(find(zeroActivity, 'escalation-rate'), undefined); // no denominator → unknown
});

test('coverage-trend: negative delta fires, non-negative clears, null omitted', () => {
  const drop = evaluateAlerts({ coverageDeltaFromPrev: -0.3 }, T, { now: NOW });
  assert.equal(find(drop, 'coverage-trend').state, 'firing');

  const flat = evaluateAlerts({ coverageDeltaFromPrev: 0 }, T, { now: NOW });
  assert.equal(find(flat, 'coverage-trend').state, 'clear');

  const none = evaluateAlerts({ coverageDeltaFromPrev: null }, T, { now: NOW });
  assert.equal(find(none, 'coverage-trend'), undefined);
});

test('claim-starvation: an old claim fires, fresh claims clear, empty omitted', () => {
  const old = evaluateAlerts({ claims: [{ createdAt: ago(30000), zone: 'src' }] }, T, { now: NOW }); // >21600
  assert.equal(find(old, 'claim-starvation').state, 'firing');

  const fresh = evaluateAlerts({ claims: [{ createdAt: ago(100), zone: 'src' }] }, T, { now: NOW });
  assert.equal(find(fresh, 'claim-starvation').state, 'clear');

  const empty = evaluateAlerts({ claims: [] }, T, { now: NOW });
  assert.equal(find(empty, 'claim-starvation'), undefined);
});

test('every firing alert carries a stable title and a non-empty body', () => {
  const out = evaluateAlerts(
    { canary: 'red', escalation: { opened: 0, escalations: 3 }, coverageDeltaFromPrev: -1, claims: [{ createdAt: ago(99999), zone: 'api' }] },
    T,
    { now: NOW },
  );
  for (const a of out) {
    assert.equal(a.title, `Northstar alert: ${a.rule}`);
    assert.ok(a.body && a.body.length > 0);
  }
  assert.equal(out.length, 4);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/alerts.test.js`
Expected: FAIL — `Cannot find module './alerts'`.

- [ ] **Step 3: Implement `lib/alerts.js`**

```js
'use strict';
// §12.1 alert rule engine. PURE: `now` is injected, never Date.now(). Each rule
// returns a decision — 'firing' or 'clear' — or is OMITTED when its input is
// missing (an absent signal is not evidence of a problem, mirroring the read-model's
// "null, never a fabricated zero" discipline). The workflow turns decisions into
// deduped issues: firing → open/comment, clear → close an open issue.
const { isStarved } = require('./substrate');

const titleFor = (rule) => `Northstar alert: ${rule}`;

function evaluateAlerts(model = {}, thresholds = {}, { now } = {}) {
  if (now == null) throw new Error('evaluateAlerts: `now` is required');
  const escalationRate = thresholds.escalationRate ?? 0.5;
  const coverageDeltaMin = thresholds.coverageDeltaMin ?? 0;
  const claimAgeSeconds = thresholds.claimAgeSeconds ?? 21600;
  const out = [];
  const push = (rule, severity, firing, body) =>
    out.push({ rule, severity, state: firing ? 'firing' : 'clear', title: titleFor(rule), body });

  // 1. Canary (page). null → omit.
  if (model.canary === 'red' || model.canary === 'green') {
    const firing = model.canary === 'red';
    push('canary', 'page', firing,
      firing
        ? 'The nightly canary ran the real engine against the known-broken fixture and did NOT produce a green fix. The model may have regressed — investigate before releasing.'
        : 'Canary is green again: the real engine fixed the known-broken fixture. Resolved.');
  }

  // 2. Escalation rate (trend). No fix activity → no denominator → omit.
  const esc = model.escalation;
  if (esc && (esc.opened != null) && (esc.escalations != null) && (esc.opened + esc.escalations) > 0) {
    const rate = esc.escalations / (esc.opened + esc.escalations);
    const firing = rate > escalationRate;
    push('escalation-rate', 'trend', firing,
      `Fix-agent escalation rate is ${(rate * 100).toFixed(0)}% (${esc.escalations} escalated / ${esc.opened + esc.escalations} attempts), threshold ${(escalationRate * 100).toFixed(0)}%.`);
  }

  // 3. Coverage trend (trend). null → omit.
  if (model.coverageDeltaFromPrev != null) {
    const d = model.coverageDeltaFromPrev;
    const firing = d < coverageDeltaMin;
    push('coverage-trend', 'trend', firing,
      firing
        ? `Coverage moved ${d} pts vs the previous baseline (negative trend on the default branch).`
        : `Coverage delta ${d} pts — not below the ${coverageDeltaMin} threshold. Resolved.`);
  }

  // 4. Claim starvation (trend). Reuses substrate.isStarved. Empty → omit.
  const claims = model.claims;
  if (Array.isArray(claims) && claims.length > 0) {
    const starved = claims.filter((c) => isStarved(c, { now, starvationThresholdSeconds: claimAgeSeconds }));
    const firing = starved.length > 0;
    push('claim-starvation', 'trend', firing,
      firing
        ? `${starved.length} zone claim(s) exceed the ${claimAgeSeconds}s starvation threshold (zones: ${starved.map((c) => c.zone).join(', ')}). An agent may be stuck.`
        : `All ${claims.length} active claim(s) are within the ${claimAgeSeconds}s threshold. Resolved.`);
  }

  return out;
}

module.exports = { evaluateAlerts, titleFor };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/alerts.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/alerts.js lib/alerts.test.js
git commit -m "feat(alerts): §12.1 rule engine (canary, escalation, coverage, starvation)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `lib/alerts-cli.js` thin I/O shell

**Files:**
- Create: `lib/alerts-cli.js`
- Test: `lib/alerts.test.js` (no new unit test — CLI is exercised by a smoke run below)

**Interfaces:**
- Consumes: `evaluateAlerts` (Task 2), `canaryFromRuns`, `coverageSeries`, `agentHealth` (metrics.js).
- Produces: a JSON array of decisions on stdout (same shape `evaluateAlerts` returns).

- [ ] **Step 1: Implement `lib/alerts-cli.js`**

```js
#!/usr/bin/env node
'use strict';
// Evaluate §12.1 alerts from gathered traces and print the decisions as JSON.
//
//   node lib/alerts-cli.js \
//     --runs runs.json --coverage coverage.json --agent agent.json --claims claims.json \
//     --now 2026-07-22T00:00:00Z \
//     --escalation-rate 0.5 --coverage-delta-min 0 --claim-age-seconds 21600 \
//     --canary-workflow 'Northstar canary'
//
// Prints a JSON array to stdout. Zero deps.
const fs = require('node:fs');
const { canaryFromRuns, coverageSeries, agentHealth } = require('./metrics');
const { evaluateAlerts } = require('./alerts');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function readJson(path, fallback) {
  if (!path) return fallback;
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return fallback; }
}

const now = arg('now');
if (!now) { console.error('alerts-cli: --now <ISO> is required'); process.exit(2); }

const runs = readJson(arg('runs'), []);
const coverageHistory = readJson(arg('coverage'), []);
const agentEvents = readJson(arg('agent'), {});
const claims = readJson(arg('claims'), []);
const thresholds = {
  escalationRate: Number(arg('escalation-rate', '0.5')),
  coverageDeltaMin: Number(arg('coverage-delta-min', '0')),
  claimAgeSeconds: Number(arg('claim-age-seconds', '21600')),
};
const canaryWorkflow = arg('canary-workflow', 'Northstar canary');

const health = agentHealth(agentEvents);
const cov = coverageSeries(coverageHistory);
const model = {
  canary: canaryFromRuns(runs, { workflowName: canaryWorkflow }),
  escalation: { opened: health.fixPrsOpened, escalations: health.escalations },
  coverageDeltaFromPrev: cov.deltaFromPrev,
  claims: Array.isArray(claims) ? claims : [],
};

process.stdout.write(JSON.stringify(evaluateAlerts(model, thresholds, { now }), null, 2) + '\n');
```

- [ ] **Step 2: Smoke-run the CLI against inline fixtures**

Run:

```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci
printf '[{"workflowName":"Northstar canary","conclusion":"failure","createdAt":"2026-07-21T00:00:00Z"}]' > /tmp/runs.json
node lib/alerts-cli.js --runs /tmp/runs.json --now 2026-07-22T00:00:00Z --canary-workflow 'Northstar canary'
```

Expected: JSON array containing an object with `"rule": "canary"`, `"state": "firing"`, `"severity": "page"`.

- [ ] **Step 3: Commit**

```bash
git add lib/alerts-cli.js
git commit -m "feat(alerts): alerts-cli — evaluate alerts from gathered traces

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `northstar-canary.yml` reusable workflow

**Files:**
- Create: `.github/workflows/northstar-canary.yml`

**Interfaces:**
- Consumes: `./.github/workflows/northstar-pipeline.yml` (same-repo call), `github.run_id`, `secrets.ANTHROPIC_API_KEY`.
- Produces: a run whose **conclusion** is the canary verdict (Task 1 reads it). Side effect: an `ns/fix/<run_id>` PR (green path), cleaned up by the `cleanup` job.

- [ ] **Step 1: Write the workflow**

```yaml
name: Northstar canary (reusable)
# NOTE: distinct from the caller's name on purpose. `gh run list` reports the
# CALLER's workflow name, so the verdict lookup keys on the caller ('Northstar
# canary'); giving the reusable its own name keeps `gh workflow run` unambiguous.
# §12.1 drift detection: run the REAL engine against a known-broken fixture on a
# schedule. A green run proves the model can still fix a known bug; a red run is an
# unambiguous "the model stopped working" signal, independent of client traffic.
# The verdict is this workflow's run conclusion — made trustworthy by the `assert`
# job, which fails unless the fix-agent actually produced a green fix PR.
on:
  workflow_call:
    inputs:
      fixture-dir:
        description: 'Workdir holding the known-broken fixture'
        type: string
        default: 'examples/aidemo'
      zones-json:
        type: string
        default: '[{"zone":"src","glob":"src/**"}]'
      engine:
        type: string
        default: 'claude-code'
      coverage-min:
        type: string
        default: '0'
      cleanup-pr:
        description: 'Close + delete the fix PR the canary produces'
        type: boolean
        default: true

permissions:
  contents: write
  pull-requests: write

jobs:
  canary:
    uses: ./.github/workflows/northstar-pipeline.yml
    with:
      workdir: ${{ inputs.fixture-dir }}
      zones-json: ${{ inputs.zones-json }}
      coverage-min: ${{ inputs.coverage-min }}
      coverage-mode: 'report'
      engine: ${{ inputs.engine }}
    secrets: inherit

  # The verdict guard. The pipeline can conclude success even when the fix-agent
  # ESCALATES (opens an ns:needs-human issue, no PR). This job fails unless a real
  # fix PR exists on ns/fix/<run_id> — converting "the workflow ran" into "the model
  # still works." github.run_id is shared across the nested reusable pipeline.
  assert:
    needs: canary
    runs-on: ubuntu-latest
    permissions:
      pull-requests: read
    steps:
      - name: Assert a green fix PR was opened
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          BRANCH: ns/fix/${{ github.run_id }}
        run: |
          set -euo pipefail
          COUNT="$(gh pr list --repo "$REPO" --head "$BRANCH" --state all --json number -q 'length')"
          if [ "$COUNT" -lt 1 ]; then
            echo "::error::canary produced no fix PR on $BRANCH — the engine failed to fix the known bug (escalated or errored)."
            exit 1
          fi
          echo "canary green: fix PR present on $BRANCH"

  # Debris cleanup. Runs on green AND red (if: always()) so a failed canary leaves
  # no open PR or branch behind. Non-fatal: never changes the verdict.
  cleanup:
    needs: [canary, assert]
    if: ${{ always() && inputs.cleanup-pr }}
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - name: Close the canary fix PR and delete its branch
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          BRANCH: ns/fix/${{ github.run_id }}
        run: |
          set -uo pipefail
          NUM="$(gh pr list --repo "$REPO" --head "$BRANCH" --state open --json number -q '.[0].number // empty')"
          if [ -n "$NUM" ]; then
            gh pr close "$NUM" --repo "$REPO" --delete-branch \
              --comment "Canary run complete — closing the disposable fix PR (verdict recorded in the run conclusion)." \
              || echo "::warning::could not close canary PR #$NUM"
          else
            # No open PR (red run, or already cleaned) — best-effort delete the branch.
            gh api -X DELETE "repos/$REPO/git/refs/heads/$BRANCH" 2>/dev/null \
              || echo "::notice::no ns/fix branch to delete for this run"
          fi
          exit 0
```

- [ ] **Step 2: Lint the workflow YAML**

Run: `cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci && python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/northstar-canary.yml')); print('yaml ok')"`
Expected: `yaml ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/northstar-canary.yml
git commit -m "feat(canary): reusable nightly-canary workflow (canary/assert/cleanup)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `canarydemo.yml` scheduled caller + alert labels

**Files:**
- Create: `.github/workflows/canarydemo.yml`

**Interfaces:**
- Consumes: `./.github/workflows/northstar-canary.yml` (Task 4). This caller's `name:` MUST equal the `canary-workflow` default (`Northstar canary`) so `gh run list` surfaces the verdict — a called reusable's runs report the CALLER's workflow name. The reusable itself is named `Northstar canary (reusable)` (Task 4) to keep the two unambiguous.

- [ ] **Step 1: Write the scheduled caller**

```yaml
name: Northstar canary
# Nightly dogfood of the canary against examples/aidemo (the a-b bug). This caller's
# `name:` is what `gh run list` reports for the verdict — it MUST match the
# canary-workflow input in northstar-metrics.yml (default 'Northstar canary').
on:
  schedule:
    - cron: '0 7 * * *'      # ~midnight PT — a red canary is waiting at day start
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
jobs:
  canary:
    uses: ./.github/workflows/northstar-canary.yml
    with:
      fixture-dir: examples/aidemo
    secrets: inherit          # passes ANTHROPIC_API_KEY to the claude-code engine
```

- [ ] **Step 2: Create the alert labels once (idempotent)**

Run (requires `gh` authed to the repo):

```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci
gh label create 'ns:alert' --color 'B60205' --description 'Northstar §12.1 drift alert' --force
gh label create 'ns:alert/page' --color 'B60205' --description 'Page the maintainer (canary red)' --force
gh label create 'ns:alert/trend' --color 'FBCA04' --description 'Trend advisory alert' --force
```

Expected: three `✓ Label created` (or updated) lines. If `gh` is not yet authed for this session, defer this to the deploy checkpoint — the metrics workflow tolerates missing labels (Task 6 uses `--force` label creation in-workflow as a backstop).

- [ ] **Step 3: Lint the workflow YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/canarydemo.yml')); print('yaml ok')"`
Expected: `yaml ok`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/canarydemo.yml
git commit -m "feat(canary): nightly canarydemo caller + ns:alert labels

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Wire alerting into `northstar-metrics.yml` + docs

**Files:**
- Modify: `.github/workflows/northstar-metrics.yml` (gather claim ages, add inputs, evaluate + act)
- Modify: `docs/observability.md`

**Interfaces:**
- Consumes: `lib/alerts-cli.js` (Task 3), `canaryFromRuns` wired via `metrics-cli.js` (Task 1).
- Produces: deduped `ns:alert` issues per firing rule; recovery-close on clear.

- [ ] **Step 1: Add alert inputs to the workflow**

In `.github/workflows/northstar-metrics.yml`, under `on.workflow_call.inputs`, append:

```yaml
      alerts:
        description: 'Write deduped alert issues (false = evaluate + render only)'
        type: boolean
        default: true
      escalation-rate:
        type: number
        default: 0.5
      coverage-delta-min:
        type: number
        default: 0
      claim-age-seconds:
        type: number
        default: 21600
      canary-workflow:
        type: string
        default: 'Northstar canary'
      alert-label:
        type: string
        default: 'ns:alert'
```

- [ ] **Step 2: Gather claim ages in the "Gather traces" step**

In the `Gather traces` step's script, REPLACE the existing coordination line that only counts claims:

```bash
          CLAIMS=$(git ls-remote --heads origin 'ns/claim/*' | grep -c . || true)
```

with a version that also extracts each claim body into `claims.json` (reusing the `git archive` technique the cost-record gather already uses):

```bash
          # Coordination: enumerate active claim refs AND extract each claim body so
          # ages are available to the starvation alert. An unreadable claim is skipped.
          CLAIM_REFS=$(git ls-remote --heads origin 'ns/claim/*' | awk '{print $2}' | sed 's#refs/heads/##')
          CLAIMS=$(printf '%s\n' "$CLAIM_REFS" | grep -c . || true)
          rm -rf .nsclaims && mkdir -p .nsclaims
          for ref in $CLAIM_REFS; do
            zone="${ref#ns/claim/}"
            git fetch origin "$ref" 2>/dev/null || continue
            git archive FETCH_HEAD ".northstar/claims/${zone}.json" 2>/dev/null \
              | tar -x -C .nsclaims 2>/dev/null || true
          done
          if ls .nsclaims/.northstar/claims/*.json >/dev/null 2>&1; then
            jq -s '.' .nsclaims/.northstar/claims/*.json > claims.json || echo '[]' > claims.json
          else
            echo '[]' > claims.json
          fi
```

(Leave the rest of the coordination `jq -n ... > extra.json` block that uses `$CLAIMS` unchanged — `CLAIMS` is still defined.)

- [ ] **Step 3: Pass `--canary-workflow` to the dashboard render**

In the `Render dashboard + digest` step, add `--canary-workflow "${CANARY_WORKFLOW}"` to BOTH `metrics-cli.js` invocations, and add the env var to that step:

```yaml
        env:
          REPO: ${{ inputs.repo || github.repository }}
          SINCE: ${{ inputs.since-days }}
          CANARY_WORKFLOW: ${{ inputs.canary-workflow }}
```

Each `node lib/metrics-cli.js ...` line gains: `--canary-workflow "$CANARY_WORKFLOW"`.

- [ ] **Step 4: Add the evaluate + act step**

Insert a new step AFTER `Render dashboard + digest` and AFTER `Commit dashboard` (so an alert-write failure can't block the dashboard commit), BEFORE the digest step:

```yaml
      - name: Evaluate + act on §12.1 alerts
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ inputs.repo || github.repository }}
          NOW_ISO: ${{ '' }}   # set at runtime below
          ALERTS: ${{ inputs.alerts }}
          ESC_RATE: ${{ inputs.escalation-rate }}
          COV_MIN: ${{ inputs.coverage-delta-min }}
          CLAIM_AGE: ${{ inputs.claim-age-seconds }}
          CANARY_WORKFLOW: ${{ inputs.canary-workflow }}
          ALERT_LABEL: ${{ inputs.alert-label }}
        run: |
          set -euo pipefail
          NOW="$(date -u +%FT%TZ)"
          node lib/alerts-cli.js \
            --runs runs.json --coverage coverage.json --agent agent.json --claims claims.json \
            --now "$NOW" \
            --escalation-rate "$ESC_RATE" --coverage-delta-min "$COV_MIN" \
            --claim-age-seconds "$CLAIM_AGE" --canary-workflow "$CANARY_WORKFLOW" \
            > alerts.json
          echo "## §12.1 Alerts" >> "$GITHUB_STEP_SUMMARY"
          jq -r '.[] | "- **\(.rule)** [\(.severity)]: \(.state)"' alerts.json >> "$GITHUB_STEP_SUMMARY" || true

          if [ "$ALERTS" != "true" ]; then
            echo "alerts: rendering only (inputs.alerts=false) — no issues written"
            exit 0
          fi

          # Backstop: ensure labels exist (idempotent) so issue creation never fails.
          gh label create "$ALERT_LABEL" --repo "$REPO" --color B60205 --force 2>/dev/null || true
          gh label create "$ALERT_LABEL/page" --repo "$REPO" --color B60205 --force 2>/dev/null || true
          gh label create "$ALERT_LABEL/trend" --repo "$REPO" --color FBCA04 --force 2>/dev/null || true

          rows="$(jq -c '.[]' alerts.json)"
          while IFS= read -r a; do
            [ -z "$a" ] && continue
            RULE="$(jq -r '.rule' <<<"$a")"
            STATE="$(jq -r '.state' <<<"$a")"
            SEV="$(jq -r '.severity' <<<"$a")"
            TITLE="$(jq -r '.title' <<<"$a")"
            BODY="$(jq -r '.body' <<<"$a")"
            NUM="$(gh issue list --repo "$REPO" --state open --label "$ALERT_LABEL" \
              --search "in:title \"$TITLE\"" --json number,title \
              -q "[.[]|select(.title==\"$TITLE\")][0].number // empty")"
            if [ "$STATE" = "firing" ]; then
              if [ -z "$NUM" ]; then
                gh issue create --repo "$REPO" --title "$TITLE" --body "$BODY" \
                  --label "$ALERT_LABEL" --label "$ALERT_LABEL/$SEV" \
                  || echo "::warning::could not create alert issue for $RULE"
              else
                gh issue comment "$NUM" --repo "$REPO" --body "Still firing: $BODY" \
                  || echo "::warning::could not comment alert issue #$NUM"
              fi
            else # clear
              if [ -n "$NUM" ]; then
                gh issue comment "$NUM" --repo "$REPO" --body "Recovered: $BODY" || true
                gh issue close "$NUM" --repo "$REPO" || echo "::warning::could not close #$NUM"
              fi
            fi
          done <<< "$rows"
```

(Remove the placeholder `NOW_ISO` env line — it is not needed; `NOW` is computed in-shell. Keep the other env vars.)

- [ ] **Step 5: Lint the workflow YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/northstar-metrics.yml')); print('yaml ok')"`
Expected: `yaml ok`.

- [ ] **Step 6: Run the full unit suite**

Run: `npm test`
Expected: all `lib/*.test.js` green (canary + alerts cases included); Python contract cases skip locally as before.

- [ ] **Step 7: Update `docs/observability.md`**

Append a section documenting: the canary (`canarydemo.yml` nightly caller, `northstar-canary.yml` reusable, required `contents: write` + `pull-requests: write` + `ANTHROPIC_API_KEY` secret, expected ~$0.02–0.10/run ≈ $10–35/yr), the four alert rules and their default thresholds, the one-issue-per-rule lifecycle (`ns:alert` + `ns:alert/page|trend`), and the `alerts: false` render-only opt-out. Include the consumer snippet:

```yaml
# Nightly canary (real-engine drift detection)
name: Northstar canary
on:
  schedule: [{ cron: '0 7 * * *' }]
  workflow_dispatch:
permissions: { contents: write, pull-requests: write }
jobs:
  canary:
    uses: dmjohnsonintl/northstar-ci/.github/workflows/northstar-canary.yml@v0
    with: { fixture-dir: examples/aidemo }
    secrets: inherit   # ANTHROPIC_API_KEY
```

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/northstar-metrics.yml docs/observability.md
git commit -m "feat(metrics): evaluate + act on §12.1 alerts; document the canary

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Deploy checkpoint (outward-facing — gate on user approval)

These steps push and run live; per the approval posture, confirm before each.

- [ ] **D1:** `git pull --rebase origin main` (local `main` is behind by bot dashboard commits), then `git push origin main`.
- [ ] **D2:** Re-tag `v0`: `git tag -f v0 && git push -f origin v0`. Verify `git rev-parse origin/main` == `git rev-parse v0`.
- [ ] **D3:** Create the alert labels if Task 5 Step 2 was deferred.
- [ ] **D4:** Dispatch the canary by filename (unambiguous): `gh workflow run canarydemo.yml --repo dmjohnsonintl/northstar-ci`. Watch it: `canary` fixes `examples/aidemo`, `assert` passes, `cleanup` closes the PR + deletes `ns/fix/<run_id>`, run concludes `success`. Confirm no leftover `ns/fix/*` branch.
- [ ] **D5:** Dispatch metricsdemo (or northstar-metrics caller); confirm the dashboard renders `🟢 green` canary and a real Cost figure from the canary's record, and that no spurious alert issues were opened.
- [ ] **D6:** (Optional red-path proof) Temporarily point the canary at a fixture the engine can't fix, or force `assert` failure; confirm the next metrics run opens `Northstar alert: canary` labeled `ns:alert/page`, then reverts and the following run comments recovery and closes it.

---

## Self-Review

**Spec coverage:**
- §1 canary/assert/cleanup workflow → Task 4 ✓
- §2 scheduled caller → Task 5 ✓
- §3 `canaryFromRuns` projection + dashboard → Task 1 ✓
- §4 `alerts.js` four rules + three states → Task 2 ✓
- §5 `alerts-cli.js` → Task 3 ✓
- §6 metrics workflow gather/evaluate/act + issue lifecycle + inputs → Task 6 ✓
- §7 error handling (missing→omit, alert-write non-fatal after dashboard commit, bounded canary) → Tasks 2/4/6 ✓
- §8 branch-complete tests → Tasks 1 & 2 ✓
- §9 proof → Deploy checkpoint D4–D6 ✓
- Acceptance criteria 1–9 → all mapped (1:T4/T5, 2:T4 assert, 3:T4 cleanup, 4:T1, 5:T5 name match, 6:T6, 7:T2, 8:T6 Step 6, 9:T6 Step 7) ✓

**Placeholder scan:** The `NOW_ISO: ${{ '' }}` line in Task 6 Step 4 is explicitly called out for removal in the same step — not a lingering placeholder. No TBD/TODO/"handle edge cases" remain.

**Type consistency:** `canaryFromRuns(runs, { workflowName })` used identically in Task 1 (metrics-cli), Task 3 (alerts-cli). `evaluateAlerts(model, thresholds, { now })` decision shape `{ rule, state, severity, title, body }` consumed unchanged in Task 6. `isStarved(claim, { now, starvationThresholdSeconds })` matches `lib/substrate.js:95`. Claim shape `{ createdAt, zone }` matches `newClaim` output.
