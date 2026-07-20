# Runner Breadth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the js-ts adapter works across node:test/Jest/Vitest, and add an opt-in Playwright system-test layer (run → flake-quarantine → layer-aware one-shot fix → human backstop) that promotes green E2E tests into the immutable regression suite.

**Architecture:** Piece A is proof-only (fixtures + demo caller workflows; the adapter is already runner-agnostic). Piece B adds two pipeline jobs (`system`, `fix-system`) that reuse the existing `run-suite`, `claim`, `signal`, and `fix-agent` actions, plus a parametric `promote-regression` so one promotion action serves both unit and E2E. Everything infrastructure-shaped is proven the way this repo always proves things: a demo caller workflow that goes green in CI.

**Tech Stack:** GitHub Actions reusable workflows + composite actions (bash), Node's built-in test runner (`node:test`) for lib unit tests, Jest, Vitest, Playwright.

## Global Constraints

- **Canonical repo:** `dmjohnsonintl/northstar-ci` (local: `/Users/davidjohnson/Documents/Claude/Projects/northstar-ci`). All work happens here.
- **Full public action refs inside the reusable workflow:** actions called from `northstar-pipeline.yml` MUST use `dmjohnsonintl/northstar-ci/actions/<name>@v0` (local `./` refs do NOT resolve when a consumer calls the reusable workflow). Demo *caller* workflows in THIS repo use the local `uses: ./.github/workflows/northstar-pipeline.yml`.
- **Release tag `v0` moves as the slice completes:** re-tag with `git tag -f v0 && git push -f origin v0` after pushing to `main`, so demo callers (`@v0`) exercise the new code. After any run that commits to `main` as `northstar[bot]` (promotion), local pushes go non-fast-forward — `git pull --rebase` then push, and verify `git rev-parse v0 == git rev-parse origin/main`.
- **Never auto-merge:** every fix opens a human-review PR; exhaustion labels `ns:needs-human`.
- **Engine default is `stub`:** demos use the stub engine (deterministic, no API spend). The real `claude-code` engine on an E2E failure is deferred to the §12.1 nightly canary.
- **Node version floor:** `node:test` lib tests run on Node 18+ (CI uses the pipeline's `node-version`, default `18`).
- **Run the full unit suite with:** `npm test` (globs `lib/*.test.js adapters/contract.test.js adapters/*/*.test.js engine/*.test.js`).
- **Bot identity for commits made by actions:** `git config user.name "northstar[bot]"` / `user.email "northstar@users.noreply.github.com"`.

---

### Task 1: Parametric `promote-regression` (staging/regression dirs + optional baseline)

Make one promotion action serve both unit and E2E. `lib/promote-cli.js` is already dir-parametric; this task exposes staging/regression as action inputs and makes the coverage-baseline copy optional (skipped when no baseline is supplied, i.e. for E2E).

**Files:**
- Test: `lib/promote-cli.test.js` (add a test)
- Modify: `actions/promote-regression/action.yml`

**Interfaces:**
- Consumes: `lib/promote-cli.js` CLI — `node lib/promote-cli.js --staging <dir> --regression <dir>` (already exists; moves staged files whose path is under `--staging` into `--regression`, preserving subpaths).
- Produces: `actions/promote-regression` composite action with inputs `workdir` (default `.`), `staging` (default `tests/new`), `regression` (default `tests/regression`), `next-baseline` (default `''`, optional — empty skips the coverage ratchet). Used by Task 5's pipeline for both unit (with baseline) and E2E (without).

- [ ] **Step 1: Write the failing test** — prove `promote-cli` promotes an arbitrary dir pair (the E2E path `e2e/new` → `e2e/regression`).

Add to `lib/promote-cli.test.js`:

```javascript
test('promote-cli promotes an arbitrary staging/regression dir pair (e2e)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-prom-e2e-'));
  fs.mkdirSync(path.join(dir, 'e2e', 'new'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'e2e', 'new', 'checkout.spec.ts'), '// e2e');
  execFileSync('node', [path.resolve('lib/promote-cli.js'), '--staging', 'e2e/new', '--regression', 'e2e/regression'], {
    cwd: dir,
  });
  assert.ok(fs.existsSync(path.join(dir, 'e2e', 'regression', 'checkout.spec.ts')));
  assert.ok(!fs.existsSync(path.join(dir, 'e2e', 'new', 'checkout.spec.ts')));
});
```

- [ ] **Step 2: Run the test to verify it passes** (promote-cli is already parametric — this is a regression guard that must be green now, and must stay green after the action change).

Run: `cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci && node --test lib/promote-cli.test.js`
Expected: PASS (both the existing test and the new e2e-dir test).

- [ ] **Step 3: Add `staging`/`regression`/optional-`next-baseline` inputs to the action.** Replace the full contents of `actions/promote-regression/action.yml` with:

```yaml
name: 'Northstar promote-regression'
description: 'On the default branch: promote green staged tests into the immutable regression suite, and (optionally) ratchet the coverage baseline. Parametric on the staging/regression dir pair so it serves both unit and E2E promotion.'
inputs:
  workdir:
    description: 'Consumer project directory (relative to the repo root)'
    default: '.'
  staging:
    description: 'Staging dir (repo-relative to workdir) whose green tests are promoted'
    default: 'tests/new'
  regression:
    description: 'Immutable regression dir (repo-relative to workdir) to promote into'
    default: 'tests/regression'
  next-baseline:
    description: 'Path to the proposed new coverage baseline (from coverage-gate), repo-root-relative. Empty = skip the coverage ratchet (e.g. E2E promotion has no coverage).'
    default: ''
runs:
  using: 'composite'
  steps:
    - shell: bash
      env:
        WORKDIR: ${{ inputs.workdir }}
        STAGING: ${{ inputs.staging }}
        REGRESSION: ${{ inputs.regression }}
        NEXT_BASELINE: ${{ inputs.next-baseline }}
      run: |
        WD="${WORKDIR%/}"
        git config user.name "northstar[bot]"
        git config user.email "northstar@users.noreply.github.com"
        # Coverage ratchet is optional: E2E promotion supplies no baseline.
        if [ -n "$NEXT_BASELINE" ]; then
          mkdir -p "$WD/.northstar"
          cp "$NEXT_BASELINE" "$WD/.northstar/coverage-baseline.json"
          git add "$WD/.northstar/coverage-baseline.json" || true
        fi
        node "${{ github.action_path }}/../../lib/promote-cli.js" \
          --staging "$WD/$STAGING" --regression "$WD/$REGRESSION"
        git add "$WD/$STAGING" "$WD/$REGRESSION" || true
        if git commit -m "chore(northstar): promote regression ($STAGING -> $REGRESSION)${NEXT_BASELINE:+ + ratchet coverage baseline}"; then
          # Land on top of any concurrent northstar[bot] push — e.g. the unit
          # promote in the gate job pushes just before this E2E promote in the
          # system job (which checked out the pre-push SHA). A plain push would
          # be non-fast-forward and silently drop the promotion.
          pushed=false
          for attempt in 1 2 3; do
            # Rebase our commit onto the moved branch; abort a conflicted rebase
            # so the next attempt starts clean (stderr is visible for diagnosis).
            git pull --rebase --autostash || { git rebase --abort 2>/dev/null || true; }
            if git push; then pushed=true; break; fi
            echo "::warning::push attempt $attempt failed — retrying after rebase"
          done
          # Fail LOUDLY if the promotion never landed: a silent exit 0 here would
          # report a green job while dropping the promotion.
          if [ "$pushed" != true ]; then
            echo "::error::promotion committed locally but push failed after 3 attempts" >&2
            exit 1
          fi
        else
          echo "nothing to commit"
        fi
```

- [ ] **Step 4: Re-run the lib test to confirm no regression.**

Run: `cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci && npm test`
Expected: PASS (whole suite; python cases may show as skipped locally — that's normal).

- [ ] **Step 5: Commit.**

```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci
git add lib/promote-cli.test.js actions/promote-regression/action.yml
git commit -m "feat(promote): parametric staging/regression dirs + optional coverage baseline

One promotion action now serves both unit (with baseline ratchet) and E2E
(no coverage) promotion. promote-cli was already dir-parametric; expose it
as action inputs and guard the baseline copy.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Jest unit-runner fixture + demo caller (Piece A)

Prove a real Jest project flows through the pipeline. No adapter changes — the js-ts adapter runs `test:ci` and reads `coverage/coverage-summary.json`, which Jest emits via the `json-summary` reporter.

**Files:**
- Create: `examples/jestdemo/package.json`
- Create: `examples/jestdemo/package-lock.json` (generated by `npm install`)
- Create: `examples/jestdemo/jest.config.js`
- Create: `examples/jestdemo/src/sum.js`
- Create: `examples/jestdemo/src/sum.test.js`
- Create: `.github/workflows/jestdemo.yml`

**Interfaces:**
- Consumes: `northstar-pipeline.yml` reusable workflow (inputs `workdir`, `adapter`, `install-cmd`, `zones-json`, `coverage-min`, `coverage-mode`, `engine`).
- Produces: a green CI run proving the Jest runner satisfies the coverage-summary contract.

- [ ] **Step 1: Create the source module** `examples/jestdemo/src/sum.js`:

```javascript
'use strict';
function sum(a, b) {
  return a + b;
}
module.exports = { sum };
```

- [ ] **Step 2: Create the passing test** `examples/jestdemo/src/sum.test.js` (covers 100% of `sum.js`):

```javascript
const { sum } = require('./sum');

test('sum adds two numbers', () => {
  expect(sum(2, 3)).toBe(5);
});
```

- [ ] **Step 3: Create the Jest config** `examples/jestdemo/jest.config.js` (json-summary reporter → `coverage/coverage-summary.json`, the exact file the adapter reads):

```javascript
module.exports = {
  collectCoverage: true,
  collectCoverageFrom: ['src/**/*.js'],
  coverageDirectory: 'coverage',
  coverageReporters: ['json-summary', 'text'],
};
```

- [ ] **Step 4: Create `examples/jestdemo/package.json`:**

```json
{
  "name": "ns-jestdemo",
  "private": true,
  "scripts": {
    "test:ci": "jest",
    "test:coverage": "jest --coverage"
  },
  "devDependencies": {
    "jest": "^29.7.0"
  }
}
```

- [ ] **Step 5: Generate the lockfile and verify Jest produces the coverage summary locally.**

Run:
```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci/examples/jestdemo
npm install
npm run test:coverage
ls coverage/coverage-summary.json
```
Expected: `npm run test:coverage` passes (1 test), and `coverage/coverage-summary.json` exists. Then remove the generated coverage dir so it isn't committed: `rm -rf coverage node_modules`.

- [ ] **Step 6: Create the demo caller** `.github/workflows/jestdemo.yml`:

```yaml
name: jestdemo
on:
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
jobs:
  demo:
    uses: ./.github/workflows/northstar-pipeline.yml
    with:
      workdir: examples/jestdemo
      adapter: js-ts
      install-cmd: npm ci
      zones-json: '[{"zone":"src","glob":"src/**"}]'
      coverage-min: '0'
      coverage-mode: 'report'
      engine: 'stub'
```

- [ ] **Step 7: Add a `.gitignore` entry for fixture build artifacts** so `coverage/` and `node_modules/` under the demo don't get committed. Append to `examples/jestdemo/.gitignore` (create it):

```
node_modules/
coverage/
```

- [ ] **Step 8: Commit, push, re-tag v0.**

```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci
git add examples/jestdemo .github/workflows/jestdemo.yml
git commit -m "test(runners): jestdemo fixture + caller — prove Jest through the pipeline

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push
git tag -f v0 && git push -f origin v0
```

- [ ] **Step 9: Dispatch the demo and confirm green** (this is the proof).

Run:
```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci
gh workflow run jestdemo.yml --ref main
sleep 20
gh run list --workflow=jestdemo.yml --limit 1
```
Then watch the newest run to completion:
```bash
gh run watch "$(gh run list --workflow=jestdemo.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
```
Expected: the run concludes **success** — the `gate` job installed deps with `npm ci`, ran Jest via `run-suite`, and the coverage-gate ran `jest --coverage` and found `coverage/coverage-summary.json`. If it committed a baseline to `main`, run `git pull --rebase && git rev-parse v0 origin/main` and re-tag v0 if they diverged.

---

### Task 3: Vitest unit-runner fixture + demo caller (Piece A)

Same shape as Task 2, with Vitest. Do not reference Task 2's files — this fixture is standalone.

**Files:**
- Create: `examples/vitedemo/package.json`
- Create: `examples/vitedemo/package-lock.json` (generated)
- Create: `examples/vitedemo/vitest.config.js`
- Create: `examples/vitedemo/src/sum.js`
- Create: `examples/vitedemo/src/sum.test.js`
- Create: `examples/vitedemo/.gitignore`
- Create: `.github/workflows/vitedemo.yml`

**Interfaces:**
- Consumes: `northstar-pipeline.yml` (same inputs as Task 2).
- Produces: a green CI run proving the Vitest runner satisfies the coverage-summary contract.

- [ ] **Step 1: Create the source module** `examples/vitedemo/src/sum.js`:

```javascript
export function sum(a, b) {
  return a + b;
}
```

- [ ] **Step 2: Create the passing test** `examples/vitedemo/src/sum.test.js`:

```javascript
import { expect, test } from 'vitest';
import { sum } from './sum.js';

test('sum adds two numbers', () => {
  expect(sum(2, 3)).toBe(5);
});
```

- [ ] **Step 3: Create the Vitest config** `examples/vitedemo/vitest.config.js` (v8 provider, json-summary reporter → `coverage/coverage-summary.json`):

```javascript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['json-summary', 'text'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.js'],
    },
  },
});
```

- [ ] **Step 4: Create `examples/vitedemo/package.json`:**

```json
{
  "name": "ns-vitedemo",
  "private": true,
  "type": "module",
  "scripts": {
    "test:ci": "vitest run",
    "test:coverage": "vitest run --coverage"
  },
  "devDependencies": {
    "vitest": "^2.1.0",
    "@vitest/coverage-v8": "^2.1.0"
  }
}
```

- [ ] **Step 5: Create `examples/vitedemo/.gitignore`:**

```
node_modules/
coverage/
```

- [ ] **Step 6: Generate the lockfile and verify Vitest produces the coverage summary locally.**

Run:
```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci/examples/vitedemo
npm install
npm run test:coverage
ls coverage/coverage-summary.json
```
Expected: the test passes (1 test) and `coverage/coverage-summary.json` exists. Then clean up: `rm -rf coverage node_modules`.

- [ ] **Step 7: Create the demo caller** `.github/workflows/vitedemo.yml`:

```yaml
name: vitedemo
on:
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
jobs:
  demo:
    uses: ./.github/workflows/northstar-pipeline.yml
    with:
      workdir: examples/vitedemo
      adapter: js-ts
      install-cmd: npm ci
      zones-json: '[{"zone":"src","glob":"src/**"}]'
      coverage-min: '0'
      coverage-mode: 'report'
      engine: 'stub'
```

- [ ] **Step 8: Commit, push, re-tag v0.**

```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci
git add examples/vitedemo .github/workflows/vitedemo.yml
git commit -m "test(runners): vitedemo fixture + caller — prove Vitest through the pipeline

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push
git tag -f v0 && git push -f origin v0
```

- [ ] **Step 9: Dispatch the demo and confirm green.**

Run:
```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci
gh workflow run vitedemo.yml --ref main
sleep 20
gh run watch "$(gh run list --workflow=vitedemo.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
```
Expected: **success** — proves Vitest's coverage output flows through the gate. Reconcile `main`/`v0` as in Task 2 Step 9 if a baseline was committed.

---

### Task 4: Layer-aware fix-agent (`layer` input → engine)

Thread a `layer` hint (default `unit`) through the fix-agent to the engine as `NS_FIX_LAYER`. The `claude-code` engine adds one line of prompt framing when the layer is `system`; the `stub` engine ignores it. Marks the spec's `zone × layer` seam without building a separate agent.

**Files:**
- Modify: `actions/fix-agent/action.yml`
- Modify: `engine/claude-code/fix.sh`

**Interfaces:**
- Consumes: nothing new.
- Produces: `actions/fix-agent` gains input `layer` (default `unit`), passed to both engine steps as env `NS_FIX_LAYER`. Task 5's `fix-system` job sets `layer: system`.

- [ ] **Step 1: Add the `layer` input to the fix-agent action.** In `actions/fix-agent/action.yml`, add to the `inputs:` block (after `test-cmd`):

```yaml
  layer:
    description: 'Which test layer this fix targets: unit | system. Advisory — passed to the engine as NS_FIX_LAYER to shape its prompt.'
    default: 'unit'
```

- [ ] **Step 2: Pass `NS_FIX_LAYER` into both engine steps.** In `actions/fix-agent/action.yml`, add `NS_FIX_LAYER: ${{ inputs.layer }}` to the `env:` of the `Engine (stub)` step and the `Engine (claude-code)` step. After the edit, the stub step's env is:

```yaml
      env:
        NS_FIX_WORKDIR: ${{ inputs.workdir }}
        NS_FIX_LOG: ${{ inputs.failing-log }}
        NS_FIX_LAYER: ${{ inputs.layer }}
```

and the claude-code step's env is:

```yaml
      env:
        NS_FIX_WORKDIR: ${{ inputs.workdir }}
        NS_FIX_LOG: ${{ inputs.failing-log }}
        NS_FIX_LAYER: ${{ inputs.layer }}
        ANTHROPIC_API_KEY: ${{ inputs.anthropic-api-key }}
```

- [ ] **Step 3: Make the claude-code prompt layer-aware.** In `engine/claude-code/fix.sh`, after the `LOG_CONTENT=...` line and before `cd "${NS_FIX_WORKDIR:?}"`, add a layer-framing variable:

```bash
# Layer-aware framing (advisory). System/E2E failures fail differently from unit
# bugs — a selector, a wait/timing issue, or a real product regression.
LAYER="${NS_FIX_LAYER:-unit}"
if [ "$LAYER" = "system" ]; then
  LAYER_NOTE="These are END-TO-END / system tests (e.g. Playwright). The failure may be a broken selector, a wait/timing issue, or a genuine product regression — investigate the app behavior, not just a single function."
else
  LAYER_NOTE=""
fi
```

Then change the `PROMPT=` assignment so the note is included (append `${LAYER_NOTE}` after the failing-test output block):

```bash
PROMPT="The test suite in this project is failing. Here is the failing-test output:

${LOG_CONTENT}

${LAYER_NOTE}

Fix the SOURCE code in this directory so the tests pass. Make the minimal change.
Do NOT weaken, skip, delete, or edit the tests to make them pass. Do NOT edit
package.json or config files. Only change source code to fix the underlying bug."

echo "[northstar] fixing at layer: $LAYER"
```

- [ ] **Step 4: Verify the stub engine still works unchanged** (it ignores `NS_FIX_LAYER`). Run it in a throwaway git repo:

```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci
D=$(mktemp -d); git -C "$D" init -q; echo x > "$D"/f; git -C "$D" add -A; git -C "$D" commit -qm init
NS_FIX_WORKDIR="$D" NS_FIX_LOG=/dev/null NS_FIX_LAYER=system GITHUB_RUN_ID=test bash engine/stub/fix.sh
git -C "$D" log --oneline -1
rm -rf "$D"
```
Expected: prints `[northstar] stub engine committed a fix` and the last commit is `fix(northstar-stub): apply known-good patch` — proving the stub is unaffected by the new env var. (The claude-code prompt change is verified live via Task 6's fix path running on the stub engine, and by code review; it is not unit-tested because it invokes the `claude` CLI.)

- [ ] **Step 5: Commit.**

```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci
git add actions/fix-agent/action.yml engine/claude-code/fix.sh
git commit -m "feat(fix-agent): layer-aware hint (unit|system) via NS_FIX_LAYER

Advisory prompt framing for the claude-code engine so a system/E2E failure is
investigated as such; stub ignores it. Marks the zone x layer seam without
building a separate specialized agent.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Pipeline `system` + `fix-system` jobs (Piece B wiring)

Add the opt-in Playwright layer to `northstar-pipeline.yml`: a `system` job (runs only when the gate passed and E2E is opted in) with retry-once flake quarantine + E2E promotion on the default branch, and a `fix-system` job mirroring the unit `fix` job.

**Files:**
- Modify: `.github/workflows/northstar-pipeline.yml`

**Interfaces:**
- Consumes: `actions/run-suite@v0` (inputs `workdir`, `adapter`, `test-cmd`, `retries`; outputs `flaky`, `attempts`), `actions/signal@v0` (inputs `type`, `zone`, `pr-number`, `ttl-seconds`, `role`), `actions/claim@v0` (inputs `mode`, `zone`, `role`, `ttl-seconds`; outputs `acquired`, `holder`), `actions/fix-agent@v0` (now with `layer`), `actions/promote-regression@v0` (Task 1's `staging`/`regression`/optional-`next-baseline`).
- Produces: a pipeline that, on E2E opt-in, runs system tests, quarantines flakes, routes deterministic failures to a layer-aware fixer, and promotes green E2E tests.

- [ ] **Step 1: Add the two new inputs.** In `.github/workflows/northstar-pipeline.yml`, under `on.workflow_call.inputs`, add after the `secret-scan` input:

```yaml
      system-tests:
        description: 'Run the Playwright/E2E system-test layer after the unit gate passes'
        type: boolean
        default: false
      system-test-cmd:
        description: 'Command to run the system/E2E suite'
        type: string
        default: 'npx playwright test'
```

- [ ] **Step 2: Add the `system` job.** Append to the `jobs:` map (after the `fix` job). It gates on the unit `gate` passing AND opt-in, runs E2E with flake-quarantine, emits `ns:signal/flaky`, promotes green E2E on the default branch, and re-asserts failure for the check status:

```yaml
  # Opt-in Playwright/E2E system-test layer. Runs ONLY when the unit gate passed
  # (test-pyramid ordering) AND the consumer opted in. Reuses run-suite's
  # retry-once flake quarantine (browser tests flake more).
  system:
    needs: gate
    if: ${{ always() && needs.gate.result == 'success' && inputs.system-tests }}
    runs-on: ubuntu-latest
    outputs:
      suite-failed: ${{ steps.suite.outcome == 'failure' }}
      zones: ${{ needs.gate.outputs.zones }}
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v5
        with:
          node-version: ${{ inputs.node-version }}
      - if: ${{ inputs.adapter == 'python' }}
        uses: actions/setup-python@v5
        with:
          python-version: ${{ inputs.python-version }}
      - name: Install project deps
        working-directory: ${{ inputs.workdir }}
        env:
          INSTALL_CMD: ${{ inputs.install-cmd }}
        run: eval "$INSTALL_CMD"
      - name: Install Playwright browsers
        working-directory: ${{ inputs.workdir }}
        run: npx playwright install --with-deps chromium
      - name: run E2E suite (retry-once flake quarantine)
        id: suite
        continue-on-error: true
        uses: dmjohnsonintl/northstar-ci/actions/run-suite@v0
        with:
          workdir: ${{ inputs.workdir }}
          adapter: ${{ inputs.adapter }}
          test-cmd: ${{ inputs.system-test-cmd }}
          retries: '1'
      - name: signal — flaky (system)
        if: ${{ steps.suite.outputs.flaky == 'true' }}
        uses: dmjohnsonintl/northstar-ci/actions/signal@v0
        with:
          type: flaky
          zone: ${{ needs.gate.outputs.zones }}
          pr-number: ${{ github.event.pull_request.number }}
          ttl-seconds: '86400'
          role: system
      # Promote green E2E tests into the immutable regression suite (default
      # branch only). No coverage ratchet — E2E produces no line coverage.
      - name: promote E2E regression (default branch only)
        if: ${{ steps.suite.outcome == 'success' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}
        uses: dmjohnsonintl/northstar-ci/actions/promote-regression@v0
        with:
          workdir: ${{ inputs.workdir }}
          staging: e2e/new
          regression: e2e/regression
      - name: Fail if the E2E suite failed
        if: ${{ steps.suite.outcome == 'failure' }}
        run: |
          echo "::error::E2E system-test suite failed"
          exit 1
```

- [ ] **Step 3: Add the `fix-system` job.** Append after the `system` job. It mirrors the unit `fix` job but keys off `system.outputs.suite-failed`, uses the E2E command, and sets `layer: system`:

```yaml
  # Layer-aware single-attempt fix for a DETERMINISTIC E2E failure (flakes were
  # already quarantined by run-suite). Mirrors the unit `fix` job; sets
  # layer=system. No claim collision with `fix`: a unit failure fails the gate,
  # which skips `system`, so the two fixers never run in the same pipeline run.
  fix-system:
    needs: system
    if: ${{ always() && needs.system.outputs.suite-failed == 'true' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
          ref: ${{ github.head_ref || github.ref_name }}
      - uses: actions/setup-node@v5
        with:
          node-version: ${{ inputs.node-version }}
      - if: ${{ inputs.adapter == 'python' }}
        uses: actions/setup-python@v5
        with:
          python-version: ${{ inputs.python-version }}
      - name: Install project deps
        working-directory: ${{ inputs.workdir }}
        env:
          INSTALL_CMD: ${{ inputs.install-cmd }}
        run: eval "$INSTALL_CMD"
      - name: Install Playwright browsers
        working-directory: ${{ inputs.workdir }}
        run: npx playwright install --with-deps chromium
      - name: Resolve the primary zone
        id: zone
        env:
          ZONES: ${{ needs.system.outputs.zones }}
        run: |
          Z="${ZONES%% *}"
          [ -z "$Z" ] && Z="repo"
          echo "name=$Z" >> "$GITHUB_OUTPUT"
          echo "[northstar] routing system fix to zone: $Z"
      - name: route-failure — acquire zone claim
        id: claim
        uses: dmjohnsonintl/northstar-ci/actions/claim@v0
        with:
          mode: acquire
          zone: ${{ steps.zone.outputs.name }}
          role: fixer
          ttl-seconds: '3600'
      - name: Zone already claimed → queue (no collision)
        if: ${{ steps.claim.outputs.acquired != 'true' }}
        run: echo "::notice::zone '${{ steps.zone.outputs.name }}' is held by ${{ steps.claim.outputs.holder }} — queuing this system fix."
      - name: Capture the failing E2E log
        if: ${{ steps.claim.outputs.acquired == 'true' }}
        continue-on-error: true
        uses: dmjohnsonintl/northstar-ci/actions/run-suite@v0
        with:
          workdir: ${{ inputs.workdir }}
          adapter: ${{ inputs.adapter }}
          test-cmd: ${{ inputs.system-test-cmd }}
          retries: '0'
      - name: fix-agent (layer=system)
        if: ${{ steps.claim.outputs.acquired == 'true' }}
        uses: dmjohnsonintl/northstar-ci/actions/fix-agent@v0
        with:
          workdir: ${{ inputs.workdir }}
          adapter: ${{ inputs.adapter }}
          test-cmd: ${{ inputs.system-test-cmd }}
          layer: system
          engine: ${{ inputs.engine }}
          failing-log: ${{ inputs.workdir }}/artifacts/test.log
          pr-title: 'Northstar system-test fix'
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
      - name: Release the zone claim
        if: ${{ always() && steps.claim.outputs.acquired == 'true' }}
        uses: dmjohnsonintl/northstar-ci/actions/claim@v0
        with:
          mode: release
          zone: ${{ steps.zone.outputs.name }}
```

- [ ] **Step 4: Lint the workflow YAML** (catch indentation/syntax before pushing).

Run:
```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/northstar-pipeline.yml')); print('YAML OK')"
```
Expected: `YAML OK`. If `python3`/`pyyaml` is unavailable, push and run `gh workflow view northstar-pipeline.yml` — it errors on invalid YAML.

- [ ] **Step 5: Commit, push, re-tag v0** (the reusable workflow change must be on `@v0` for Task 6's demo to use it).

```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci
git add .github/workflows/northstar-pipeline.yml
git commit -m "feat(pipeline): opt-in Playwright system-test layer (system + fix-system jobs)

system job runs after a green unit gate when system-tests=true: E2E via run-suite
with retry-once flake quarantine, ns:signal/flaky, and E2E promotion on the default
branch. fix-system mirrors the unit fix job with layer=system. No claim collision:
a unit failure skips the system job.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push
git tag -f v0 && git push -f origin v0
```

---

### Task 6: e2edemo fixture + caller — prove run → pass → promote (Piece B proof)

A minimal Playwright fixture proving the `system` job end-to-end in CI: E2E runs, passes, and a staged E2E test is promoted into the regression suite on the default branch.

**Files:**
- Create: `examples/e2edemo/package.json`
- Create: `examples/e2edemo/package-lock.json` (generated)
- Create: `examples/e2edemo/playwright.config.js`
- Create: `examples/e2edemo/tests/home.spec.js`
- Create: `examples/e2edemo/e2e/new/promoted.spec.js`
- Create: `examples/e2edemo/.gitignore`
- Create: `.github/workflows/e2edemo.yml`

**Interfaces:**
- Consumes: `northstar-pipeline.yml` with `system-tests: true`.
- Produces: a green CI run proving the system layer + E2E promotion.

- [ ] **Step 1: Create a static page to test** `examples/e2edemo/index.html`:

```html
<!doctype html>
<html><head><title>ns-e2edemo</title></head>
<body><h1 id="greeting">Hello, Northstar</h1></body></html>
```

- [ ] **Step 2: Create the passing E2E test** `examples/e2edemo/tests/home.spec.js` (serves the static file via Playwright's built-in webServer):

```javascript
const { test, expect } = require('@playwright/test');

test('home page shows the greeting', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#greeting')).toHaveText('Hello, Northstar');
});
```

- [ ] **Step 3: Create the Playwright config** `examples/e2edemo/playwright.config.js` (chromium only; static server via `npx serve`):

```javascript
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npx --yes serve -l 3000 .',
    url: 'http://127.0.0.1:3000/index.html',
    reuseExistingServer: false,
  },
});
```

- [ ] **Step 4: Create a staged E2E test to be promoted** `examples/e2edemo/e2e/new/promoted.spec.js` (proves `e2e/new` → `e2e/regression`; it is NOT run by the suite — `testDir` is `./tests`):

```javascript
// Staged E2E test. Present on the default branch => promoted into e2e/regression.
const { test, expect } = require('@playwright/test');

test('staged: greeting is present', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#greeting')).toBeVisible();
});
```

- [ ] **Step 5: Create `examples/e2edemo/package.json`:**

```json
{
  "name": "ns-e2edemo",
  "private": true,
  "scripts": {
    "test:ci": "echo 'no unit tests in the e2e demo' && exit 0",
    "test:coverage": "echo 'no coverage in the e2e demo' && exit 0"
  },
  "devDependencies": {
    "@playwright/test": "^1.47.0"
  }
}
```

- [ ] **Step 6: Create `examples/e2edemo/.gitignore`:**

```
node_modules/
test-results/
playwright-report/
```

- [ ] **Step 7: Generate the lockfile and verify the E2E test passes locally.**

Run:
```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci/examples/e2edemo
npm install
npx playwright install --with-deps chromium
npx playwright test
```
Expected: 1 passing test. Then clean up: `rm -rf node_modules test-results playwright-report`.

- [ ] **Step 8: Create the demo caller** `.github/workflows/e2edemo.yml`. Note `coverage-mode: report` + `coverage-min: 0` so the unit gate passes trivially (the demo's `test:ci`/`test:coverage` are no-ops with a committed coverage summary — see Step 9), then the `system` job runs the real Playwright suite:

```yaml
name: e2edemo
on:
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
jobs:
  demo:
    uses: ./.github/workflows/northstar-pipeline.yml
    with:
      workdir: examples/e2edemo
      adapter: js-ts
      install-cmd: npm ci
      zones-json: '[{"zone":"e2e","glob":"tests/**"}]'
      coverage-min: '0'
      coverage-mode: 'report'
      engine: 'stub'
      secret-scan: false
      system-tests: true
```

- [ ] **Step 9: Give the unit gate a coverage summary to read** (the js-ts coverage-gate runs `test:coverage` then reads `coverage/coverage-summary.json`; the no-op script won't create one, so commit a static 100% summary like `examples/fixdemo/coverage/coverage-summary.json`). Create `examples/e2edemo/coverage/coverage-summary.json`:

```json
{
  "total": {
    "lines": { "total": 1, "covered": 1, "skipped": 0, "pct": 100 },
    "statements": { "total": 1, "covered": 1, "skipped": 0, "pct": 100 },
    "functions": { "total": 1, "covered": 1, "skipped": 0, "pct": 100 },
    "branches": { "total": 0, "covered": 0, "skipped": 0, "pct": 100 }
  }
}
```

Then update `.gitignore` so this committed file is NOT ignored — the demo's `coverage/` is intentionally committed here (unlike Tasks 2/3). Do NOT add `coverage/` to `examples/e2edemo/.gitignore` (Step 6 already omits it — confirm it's absent).

- [ ] **Step 10: Commit, push, re-tag v0.**

```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci
git add examples/e2edemo .github/workflows/e2edemo.yml
git commit -m "test(system): e2edemo fixture + caller — prove Playwright run + E2E promotion

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push
git tag -f v0 && git push -f origin v0
```

- [ ] **Step 11: Dispatch and confirm the system layer is proven green** (run → pass → promote).

Run:
```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci
gh workflow run e2edemo.yml --ref main
sleep 25
RID="$(gh run list --workflow=e2edemo.yml --limit 1 --json databaseId -q '.[0].databaseId')"
gh run watch "$RID" --exit-status
gh run view "$RID" --json jobs -q '.jobs[] | {name:.name, conclusion:.conclusion}'
```
Expected: overall **success**; the `system` job concluded success (Playwright ran and passed), and (because dispatched from `main`, the default branch) it committed a `promote regression (e2e/new -> e2e/regression)` commit — verify: `git pull --rebase && test -f examples/e2edemo/e2e/regression/promoted.spec.js && ! test -f examples/e2edemo/e2e/new/promoted.spec.js && echo "PROMOTED OK"`. The `fix-system` job should be **skipped** (E2E passed). Reconcile `v0`/`origin/main` after the bot commit and re-tag v0 if needed.

- [ ] **Step 12: (Optional, offline verification of the failure path) — confirm the fix-system routing wiring** by temporarily breaking the E2E test on a scratch branch and dispatching, expecting `fix-system` to run on the stub engine (opens a PR / labels ns:needs-human). This is optional because it commits a deliberate failure; if performed, do it on a throwaway branch and delete it after. Skip if you want to keep `main` clean — the wiring mirrors the proven unit `fix` job exactly.

---

### Task 7: Docs — system-test layer + security note

**Files:**
- Create: `docs/system-tests.md`
- Modify: `SECURITY.md`

**Interfaces:**
- Consumes: nothing.
- Produces: consumer-facing docs for opting into the system-test layer.

- [ ] **Step 1: Write `docs/system-tests.md`:**

```markdown
# System-test layer (Playwright / E2E)

Northstar's unit gate (coverage + suite) runs first. When it passes, an optional
**system-test layer** runs your end-to-end suite (Playwright by default). It is
**off by default** — opt in per repo.

## Opting in

In your caller workflow's `with:` block:

```yaml
with:
  # ...your existing unit-gate inputs...
  system-tests: true
  system-test-cmd: npx playwright test   # default; override if needed
```

The `system` job:
- runs **only after the unit gate passes** (test-pyramid ordering);
- installs Playwright browsers (`npx playwright install --with-deps chromium`);
- runs your E2E suite with **retry-once flake quarantine** — a test that fails
  then passes is flagged `ns:signal/flaky` and treated as green (never routed
  to a fixer);
- on the **default branch**, promotes green staged E2E tests from `e2e/new`
  into the immutable `e2e/regression` suite (no coverage ratchet).

## When an E2E test fails deterministically

A double failure routes to the **layer-aware fix-agent** (`layer=system`): it
claims the zone, hands the E2E failure log to the configured engine for a single
attempt, and — on green — opens a **human-review PR** (never auto-merged). If it
can't fix it, it labels `ns:needs-human`. Set `engine: claude-code` (plus an
`ANTHROPIC_API_KEY` secret) for real fixes; the default `stub` engine only
demonstrates the wiring.

## Staging E2E tests for promotion

Put newly-authored E2E tests under `e2e/new/`. Once they're green on the default
branch, Northstar moves them into `e2e/regression/` — the immutable suite that
guards against future regressions.
```

- [ ] **Step 2: Add a system-test note to `SECURITY.md`.** Append a subsection:

```markdown
## System-test layer (Playwright)

The opt-in system-test layer runs your end-to-end suite in CI — this executes
consumer application code, same as the unit suite. Deterministic E2E failures may
route to the fix-agent, which, like all Northstar fixes, only ever opens a
**human-review PR and never auto-merges**. Flaky E2E failures are quarantined and
never trigger an automated fix.
```

- [ ] **Step 3: Commit.**

```bash
cd /Users/davidjohnson/Documents/Claude/Projects/northstar-ci
git add docs/system-tests.md SECURITY.md
git commit -m "docs: system-test layer (opt-in Playwright) + security note

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push
```

---

## Acceptance criteria (maps to the spec)

1. **Jest + Vitest proven** — `jestdemo.yml` (Task 2) and `vitedemo.yml` (Task 3) run the full pipeline green in CI.
2. **E2E runs + promotes** — `e2edemo.yml` (Task 6) `system` job green; `e2e/new/promoted.spec.js` moved to `e2e/regression/` on the default branch.
3. **Failures route, flakes don't** — `fix-system` job (Task 5) mirrors the proven unit `fix` job with `layer: system`; `run-suite retries: 1` quarantines flakes and emits `ns:signal/flaky` (role=system).
4. **Unit promotion unchanged + tested** — `promote-regression` (Task 1) keeps default behavior; `lib/promote-cli.test.js` covers the parametric dir path.
5. **Opt-in is opt-in** — `system-tests` defaults to `false` (Task 5); a repo that doesn't opt in runs no new jobs (`system` job `if` requires `inputs.system-tests`).
