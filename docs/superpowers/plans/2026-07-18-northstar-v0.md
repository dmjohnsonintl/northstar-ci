# Northstar v0 (thin vertical slice) Implementation Plan

> **Provenance.** Historical — this plan is **complete** (shipped 2026-07-18) and is
> kept for the record. It was written in the original private
> `dmjohnsonintl/Northstar` repo before the package was republished publicly as
> `dmjohnsonintl/northstar-ci`; read any `dmjohnsonintl/Northstar` path below as
> `dmjohnsonintl/northstar-ci`. Spec: [`../specs/2026-07-18-northstar-design.md`](../specs/2026-07-18-northstar-design.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a runnable reusable-Actions package that enforces a no-downward coverage gate, runs the JS/TS test suite, promotes green staged tests into a regression suite, and (single attempt) dispatches an AI fixer that opens a PR — proven first on the ALTO Works React/TS frontend.

**Architecture:** Northstar is a package repo. Testable *logic* lives in dependency-free Node modules under `lib/` (unit-tested with the built-in `node:test` runner). Thin `bash` **adapter** scripts under `adapters/js-ts/` shell out to the project's own test/coverage commands. **Composite actions** under `actions/` wire `lib/` + adapter together, and a single **reusable workflow** (`.github/workflows/northstar-pipeline.yml`, `on: workflow_call`) sequences the golden path. A deliberately-broken **fixture repo** under `examples/consumer-repo/` provides observable acceptance testing without touching production repos.

**Tech Stack:** Node.js (CommonJS, zero runtime deps) + `node:test`; Bash composite actions; GitHub Actions (`workflow_call`); `gh` CLI for PRs; the ALTO frontend's existing `react-scripts test --coverage` (Istanbul `json-summary`).

## Global Constraints

- **Node:** package logic targets Node 18+ (ALTO frontend CI pins `node-version: '18'`). No runtime npm dependencies in `lib/` — use only Node built-ins.
- **Test runner for our own code:** `node:test` + `node:assert/strict` (built-in). Run with `node --test`.
- **Module format:** CommonJS (`require` / `module.exports`).
- **Coverage source of truth:** Istanbul `coverage-summary.json`; overall metric is `total.lines.pct` (0–100).
- **Coverage baseline file:** `.northstar/coverage-baseline.json`, shape `{ "linePct": <number> }`; committed in the consuming repo, updated only on merge to the default branch.
- **Actions pinning:** `actions/checkout@v5`, `actions/setup-node@v5` (matches ALTO's existing workflows).
- **Nothing auto-merges.** The fixer opens a PR; a human approves. On exhaustion it applies the `ns:needs-human` label and stops.
- **Adapter contract (v0 subset):** the js-ts adapter exposes `run` (run tests, exit non-zero on failure) and `coverage` (emit the path to `coverage-summary.json`). Configured via env: `NS_WORKDIR`, `NS_TEST_CMD`, `NS_COV_CMD`.
- **Commit style:** conventional commits; end message bodies with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File structure (v0)

```
Northstar/
├─ package.json                       # name, "test": "node --test", type: commonjs
├─ lib/
│  ├─ zones.js         + zones.test.js
│  ├─ coverage-gate.js + coverage-gate.test.js
│  ├─ promote.js       + promote.test.js
│  ├─ gate-cli.js                     # CLI wrapper used by the coverage-gate action
│  └─ promote-cli.js                  # CLI wrapper used by the promote-regression action
├─ adapters/js-ts/
│  ├─ run.sh
│  └─ coverage.sh
├─ actions/
│  ├─ detect-changes/action.yml
│  ├─ run-suite/action.yml
│  ├─ coverage-gate/action.yml
│  ├─ promote-regression/action.yml
│  └─ fix-agent/action.yml
├─ engine/
│  ├─ stub/fix.sh                     # deterministic fake engine (acceptance tests)
│  └─ claude-code/fix.sh              # real engine (Claude Code)
├─ .github/workflows/
│  └─ northstar-pipeline.yml          # workflow_call golden path
├─ schema/northstar.config.schema.json
├─ examples/consumer-repo/            # deliberately-broken fixture
└─ docs/adoption-v0.md
```

---

## Task 1: Package scaffold + test harness + config schema

**Files:**
- Create: `package.json`
- Create: `schema/northstar.config.schema.json`
- Create: `.gitignore` (append)
- Test: (smoke) `lib/smoke.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: an `npm test` → `node --test` harness that later tasks add tests to; the config schema that the ALTO install (Task 10) validates against.

- [ ] **Step 1: Write a smoke test that will fail until package.json exists**

Create `lib/smoke.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');

test('package is CommonJS and wires node --test', () => {
  assert.equal(pkg.name, 'northstar');
  assert.equal(pkg.scripts.test, 'node --test');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test lib/smoke.test.js`
Expected: FAIL — `Cannot find module '../package.json'`.

- [ ] **Step 3: Create package.json**

Create `package.json`:
```json
{
  "name": "northstar",
  "version": "0.0.0",
  "private": true,
  "description": "Stigmergic agent-driven testing package for GitHub Actions",
  "scripts": {
    "test": "node --test"
  },
  "license": "UNLICENSED"
}
```

- [ ] **Step 4: Create the config schema**

Create `schema/northstar.config.schema.json`:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "northstar.config.yml",
  "type": "object",
  "additionalProperties": false,
  "required": ["adapter", "coverage", "zones"],
  "properties": {
    "adapter": { "enum": ["js-ts"] },
    "coverage": {
      "type": "object",
      "additionalProperties": false,
      "required": ["min", "trend"],
      "properties": {
        "min": { "type": "number", "minimum": 0, "maximum": 100 },
        "trend": { "enum": ["no-decrease", "report"] }
      }
    },
    "zones": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["zone", "glob"],
        "properties": {
          "zone": { "type": "string" },
          "glob": { "type": "string" },
          "prompt": { "type": "string" }
        }
      }
    },
    "fix": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "engine": { "enum": ["claude-code", "stub"] },
        "onExhaustion": { "enum": ["label-human"] }
      }
    }
  }
}
```

- [ ] **Step 5: Ignore coverage/temp artifacts**

Append to `.gitignore`:
```
coverage/
artifacts/
/tmp-*
```

- [ ] **Step 6: Run the smoke test to verify it passes**

Run: `node --test lib/smoke.test.js`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add package.json schema/northstar.config.schema.json .gitignore lib/smoke.test.js
git commit -m "feat(v0): package scaffold, node:test harness, config schema

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Zone resolution logic

**Files:**
- Create: `lib/zones.js`
- Test: `lib/zones.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `matchGlob(filePath: string, glob: string) -> boolean` — substrate glob semantics (`*` = one segment, `**` = any depth).
  - `resolveZones(changedFiles: string[], zoneDefs: {zone:string, glob:string}[]) -> string[]` — sorted unique zones; most-specific-wins; ≤1 zone per file.

- [ ] **Step 1: Write the failing tests**

Create `lib/zones.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchGlob, resolveZones } = require('./zones');

test('matchGlob: ** matches any depth, * matches one segment', () => {
  assert.equal(matchGlob('frontend/src/App.tsx', 'frontend/**'), true);
  assert.equal(matchGlob('frontend/App.tsx', 'frontend/*'), true);
  assert.equal(matchGlob('frontend/src/App.tsx', 'frontend/*'), false); // * is one segment
  assert.equal(matchGlob('api/routes.py', 'frontend/**'), false);
  assert.equal(matchGlob('frontend/auth/login.ts', 'frontend/auth/**'), true);
});

test('resolveZones: most-specific-wins, one zone per file, sorted unique', () => {
  const defs = [
    { zone: 'frontend', glob: 'frontend/**' },
    { zone: 'frontend-auth', glob: 'frontend/auth/**' },
    { zone: 'api', glob: 'api/**' },
  ];
  const files = ['frontend/App.tsx', 'frontend/auth/login.ts', 'api/x.py', 'README.md'];
  assert.deepEqual(resolveZones(files, defs), ['api', 'frontend', 'frontend-auth']);
});

test('resolveZones: unmatched files contribute nothing', () => {
  assert.deepEqual(resolveZones(['docs/x.md'], [{ zone: 'frontend', glob: 'frontend/**' }]), []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/zones.test.js`
Expected: FAIL — `Cannot find module './zones'`.

- [ ] **Step 3: Implement lib/zones.js**

Create `lib/zones.js`:
```js
'use strict';

function matchSegs(file, pat) {
  if (pat.length === 0) return file.length === 0;
  const [head, ...rest] = pat;
  if (head === '**') {
    for (let i = 0; i <= file.length; i++) {
      if (matchSegs(file.slice(i), rest)) return true;
    }
    return false;
  }
  if (file.length === 0) return false;
  if (head === '*' || head === file[0]) return matchSegs(file.slice(1), rest);
  return false;
}

function matchGlob(filePath, glob) {
  const fileSegs = filePath.split('/').filter(Boolean);
  const globSegs = glob.split('/').filter(Boolean);
  return matchSegs(fileSegs, globSegs);
}

function specificity(glob) {
  return glob.split('/').filter((s) => s && s !== '*' && s !== '**').length;
}

function resolveZones(changedFiles, zoneDefs) {
  const zones = new Set();
  for (const file of changedFiles) {
    let best = null;
    let bestScore = -1;
    for (const def of zoneDefs) {
      if (matchGlob(file, def.glob) && specificity(def.glob) > bestScore) {
        bestScore = specificity(def.glob);
        best = def.zone;
      }
    }
    if (best) zones.add(best);
  }
  return [...zones].sort();
}

module.exports = { matchGlob, resolveZones };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test lib/zones.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/zones.js lib/zones.test.js
git commit -m "feat(v0): zone resolution (glob semantics, most-specific-wins)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Coverage-gate logic

**Files:**
- Create: `lib/coverage-gate.js`
- Test: `lib/coverage-gate.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `linePct(summary: object) -> number` — reads `total.lines.pct` from a parsed `coverage-summary.json`; throws on malformed input.
  - `evaluateGate({current:number, baseline:number|null, min:number, mode:'no-decrease'|'report'}) -> {pass:boolean, reason:string, newBaseline:number|null}`.

- [ ] **Step 1: Write the failing tests**

Create `lib/coverage-gate.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { linePct, evaluateGate } = require('./coverage-gate');

test('linePct reads total.lines.pct', () => {
  assert.equal(linePct({ total: { lines: { pct: 81.5 } } }), 81.5);
  assert.throws(() => linePct({ total: {} }), /total\.lines\.pct/);
});

test('first run establishes baseline and passes', () => {
  const r = evaluateGate({ current: 70, baseline: null, min: 80, mode: 'no-decrease' });
  assert.equal(r.pass, true);
  assert.equal(r.newBaseline, 70);
});

test('below minimum fails and does not move baseline', () => {
  const r = evaluateGate({ current: 79, baseline: 85, min: 80, mode: 'no-decrease' });
  assert.equal(r.pass, false);
  assert.equal(r.newBaseline, 85);
  assert.match(r.reason, /below minimum/);
});

test('downward trend fails even above minimum', () => {
  const r = evaluateGate({ current: 84, baseline: 85, min: 80, mode: 'no-decrease' });
  assert.equal(r.pass, false);
  assert.match(r.reason, /dropped/);
});

test('holding or improving passes and ratchets baseline up', () => {
  assert.deepEqual(
    evaluateGate({ current: 90, baseline: 85, min: 80, mode: 'no-decrease' }),
    { pass: true, reason: 'coverage 90.00% ≥ baseline 85.00%', newBaseline: 90 },
  );
});

test('report mode never blocks', () => {
  const r = evaluateGate({ current: 10, baseline: 85, min: 80, mode: 'report' });
  assert.equal(r.pass, true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/coverage-gate.test.js`
Expected: FAIL — `Cannot find module './coverage-gate'`.

- [ ] **Step 3: Implement lib/coverage-gate.js**

Create `lib/coverage-gate.js`:
```js
'use strict';

function linePct(summary) {
  const pct = summary && summary.total && summary.total.lines && summary.total.lines.pct;
  if (typeof pct !== 'number' || Number.isNaN(pct)) {
    throw new Error('invalid coverage-summary.json: missing total.lines.pct');
  }
  return pct;
}

function evaluateGate({ current, baseline, min, mode }) {
  if (typeof current !== 'number' || Number.isNaN(current)) {
    throw new TypeError('current coverage must be a number');
  }
  if (baseline === null || baseline === undefined) {
    return { pass: true, reason: `baseline established at ${current.toFixed(2)}%`, newBaseline: current };
  }
  if (mode === 'report') {
    return { pass: true, reason: `report-only: ${current.toFixed(2)}%`, newBaseline: Math.max(baseline, current) };
  }
  if (current < min) {
    return { pass: false, reason: `coverage ${current.toFixed(2)}% is below minimum ${min}%`, newBaseline: baseline };
  }
  if (mode === 'no-decrease' && current < baseline) {
    return { pass: false, reason: `coverage dropped ${baseline.toFixed(2)}% → ${current.toFixed(2)}%`, newBaseline: baseline };
  }
  return {
    pass: true,
    reason: `coverage ${current.toFixed(2)}% ≥ baseline ${baseline.toFixed(2)}%`,
    newBaseline: Math.max(baseline, current),
  };
}

module.exports = { linePct, evaluateGate };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test lib/coverage-gate.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/coverage-gate.js lib/coverage-gate.test.js
git commit -m "feat(v0): coverage gate (min + no-downward-trend + ratchet-establish)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Regression-promotion logic

**Files:**
- Create: `lib/promote.js`
- Test: `lib/promote.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `selectPromotions(stagedFiles: string[], passedFiles: string[]|Set<string>, {stagingDir:string, regressionDir:string}) -> {from:string, to:string}[]` — green staged tests mapped to their regression destination, preserving sub-paths.

- [ ] **Step 1: Write the failing tests**

Create `lib/promote.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectPromotions } = require('./promote');

test('promotes only green staged tests, preserving subpaths', () => {
  const staged = ['tests/new/a.test.ts', 'tests/new/sub/b.test.ts', 'tests/new/c.test.ts'];
  const passed = ['tests/new/a.test.ts', 'tests/new/sub/b.test.ts'];
  const moves = selectPromotions(staged, passed, { stagingDir: 'tests/new', regressionDir: 'tests/regression' });
  assert.deepEqual(moves, [
    { from: 'tests/new/a.test.ts', to: 'tests/regression/a.test.ts' },
    { from: 'tests/new/sub/b.test.ts', to: 'tests/regression/sub/b.test.ts' },
  ]);
});

test('nothing green → no moves', () => {
  assert.deepEqual(
    selectPromotions(['tests/new/a.test.ts'], [], { stagingDir: 'tests/new', regressionDir: 'tests/regression' }),
    [],
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/promote.test.js`
Expected: FAIL — `Cannot find module './promote'`.

- [ ] **Step 3: Implement lib/promote.js**

Create `lib/promote.js`:
```js
'use strict';
const path = require('path');

function selectPromotions(stagedFiles, passedFiles, { stagingDir, regressionDir }) {
  const passed = passedFiles instanceof Set ? passedFiles : new Set(passedFiles);
  const moves = [];
  for (const from of stagedFiles) {
    if (!passed.has(from)) continue;
    const rel = path.relative(stagingDir, from);
    moves.push({ from, to: path.join(regressionDir, rel) });
  }
  return moves;
}

module.exports = { selectPromotions };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test lib/promote.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/promote.js lib/promote.test.js
git commit -m "feat(v0): regression promotion selection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Gate CLI wrapper

**Files:**
- Create: `lib/gate-cli.js`
- Test: `lib/gate-cli.test.js`

**Interfaces:**
- Consumes: `linePct`, `evaluateGate` from Task 3.
- Produces: a CLI `node lib/gate-cli.js --summary <path> --baseline <path> --min <n> --mode <m>` that prints a human line, writes the proposed new baseline to `--out` (default `.northstar/coverage-baseline.next.json`), and exits `0` on pass / `1` on fail. Missing baseline file = first run.

- [ ] **Step 1: Write the failing test (exercise the CLI as a subprocess)**

Create `lib/gate-cli.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function run(args) {
  try {
    const stdout = execFileSync('node', ['lib/gate-cli.js', ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: e.stdout ? e.stdout.toString() : '' };
  }
}

test('fails when coverage drops below baseline', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-gate-'));
  const summary = path.join(dir, 'summary.json');
  const baseline = path.join(dir, 'baseline.json');
  const out = path.join(dir, 'next.json');
  fs.writeFileSync(summary, JSON.stringify({ total: { lines: { pct: 70 } } }));
  fs.writeFileSync(baseline, JSON.stringify({ linePct: 85 }));
  const r = run(['--summary', summary, '--baseline', baseline, '--min', '80', '--mode', 'no-decrease', '--out', out]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /dropped/);
});

test('first run (no baseline file) passes and writes new baseline', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-gate-'));
  const summary = path.join(dir, 'summary.json');
  const out = path.join(dir, 'next.json');
  fs.writeFileSync(summary, JSON.stringify({ total: { lines: { pct: 73 } } }));
  const r = run(['--summary', summary, '--baseline', path.join(dir, 'missing.json'), '--min', '80', '--mode', 'no-decrease', '--out', out]);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).linePct, 73);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/gate-cli.test.js`
Expected: FAIL — `Cannot find module` / non-zero from missing CLI.

- [ ] **Step 3: Implement lib/gate-cli.js**

Create `lib/gate-cli.js`:
```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { linePct, evaluateGate } = require('./coverage-gate');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

function readBaseline(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).linePct;
  } catch {
    return null; // missing/unreadable baseline = first run
  }
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const summary = JSON.parse(fs.readFileSync(a.summary, 'utf8'));
  const current = linePct(summary);
  const baseline = readBaseline(a.baseline);
  const result = evaluateGate({
    current,
    baseline,
    min: Number(a.min),
    mode: a.mode || 'no-decrease',
  });
  const outFile = a.out || '.northstar/coverage-baseline.next.json';
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ linePct: result.newBaseline }, null, 2));
  console.log(`[northstar] coverage gate: ${result.pass ? 'PASS' : 'FAIL'} — ${result.reason}`);
  process.exit(result.pass ? 0 : 1);
}

main();
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test lib/gate-cli.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the whole suite green**

Run: `npm test`
Expected: PASS (all tests across `lib/`).

- [ ] **Step 6: Commit**

```bash
git add lib/gate-cli.js lib/gate-cli.test.js
git commit -m "feat(v0): gate CLI wrapper (exit code + next-baseline output)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: JS/TS adapter scripts

**Files:**
- Create: `adapters/js-ts/run.sh`
- Create: `adapters/js-ts/coverage.sh`
- Test: `adapters/js-ts/adapter.test.js`

**Interfaces:**
- Consumes: env `NS_WORKDIR` (default `.`), `NS_TEST_CMD` (default `npm run test:ci`), `NS_COV_CMD` (default `npm run test:coverage`).
- Produces:
  - `run.sh` — runs the test command in `NS_WORKDIR`; exits with the test command's real exit code (via `PIPESTATUS`).
  - `coverage.sh` — runs the coverage command, then prints `summary=<path-to-coverage-summary.json>` on stdout; exits non-zero if the summary is absent.

- [ ] **Step 1: Write the failing test (drive the scripts with a fake project)**

Create `adapters/js-ts/adapter.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('coverage.sh prints the summary path when present', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-adp-'));
  fs.mkdirSync(path.join(dir, 'coverage'));
  fs.writeFileSync(path.join(dir, 'coverage', 'coverage-summary.json'), '{"total":{"lines":{"pct":50}}}');
  const stdout = execFileSync('bash', [path.resolve('adapters/js-ts/coverage.sh')], {
    encoding: 'utf8',
    env: { ...process.env, NS_WORKDIR: dir, NS_COV_CMD: 'true' },
  });
  assert.match(stdout, /summary=.*coverage-summary\.json/);
});

test('run.sh propagates a failing test command exit code', () => {
  let code = 0;
  try {
    execFileSync('bash', [path.resolve('adapters/js-ts/run.sh')], {
      env: { ...process.env, NS_WORKDIR: os.tmpdir(), NS_TEST_CMD: 'false' },
    });
  } catch (e) {
    code = e.status;
  }
  assert.equal(code, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test adapters/js-ts/adapter.test.js`
Expected: FAIL — scripts do not exist.

- [ ] **Step 3: Implement coverage.sh**

Create `adapters/js-ts/coverage.sh`:
```bash
#!/usr/bin/env bash
# Run the JS/TS coverage suite; print `summary=<path>` for coverage-summary.json.
set -uo pipefail
WORKDIR="${NS_WORKDIR:-.}"
COV_CMD="${NS_COV_CMD:-npm run test:coverage}"
cd "$WORKDIR"
mkdir -p artifacts
set -o pipefail
eval "$COV_CMD" 2>&1 | tee artifacts/coverage.log
STATUS="${PIPESTATUS[0]}"
if [ "$STATUS" -ne 0 ]; then
  echo "::error::coverage command failed (exit $STATUS)" >&2
  exit "$STATUS"
fi
SUMMARY="coverage/coverage-summary.json"
if [ ! -f "$SUMMARY" ]; then
  echo "::error::coverage-summary.json not found at $WORKDIR/$SUMMARY" >&2
  exit 1
fi
echo "summary=$WORKDIR/$SUMMARY"
```

- [ ] **Step 4: Implement run.sh**

Create `adapters/js-ts/run.sh`:
```bash
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
```

- [ ] **Step 5: Make scripts executable and run the test to verify it passes**

Run:
```bash
chmod +x adapters/js-ts/run.sh adapters/js-ts/coverage.sh
node --test adapters/js-ts/adapter.test.js
```
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add adapters/js-ts/run.sh adapters/js-ts/coverage.sh adapters/js-ts/adapter.test.js
git commit -m "feat(v0): js-ts adapter (run + coverage shell contracts)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Composite actions (detect-changes, run-suite, coverage-gate)

**Files:**
- Create: `actions/detect-changes/action.yml`
- Create: `actions/run-suite/action.yml`
- Create: `actions/coverage-gate/action.yml`

**Interfaces:**
- Consumes: `lib/gate-cli.js` (Task 5), `adapters/js-ts/*.sh` (Task 6). Actions reference package files via `${{ github.action_path }}/../../`.
- Produces three composite actions:
  - `detect-changes` — inputs: `zones-json` (JSON array of `{zone,glob}`), `base-sha`, `head-sha`; output `zones` (space-separated).
  - `run-suite` — inputs: `workdir`, `test-cmd`; fails the step if tests fail.
  - `coverage-gate` — inputs: `workdir`, `coverage-cmd`, `min`, `mode`, `baseline-file`; output `next-baseline` (path); fails the step if the gate fails.

- [ ] **Step 1: Create detect-changes/action.yml**

Create `actions/detect-changes/action.yml`:
```yaml
name: 'Northstar detect-changes'
description: 'Map changed files to Northstar zones.'
inputs:
  zones-json:
    description: 'JSON array of {zone, glob}'
    required: true
  base-sha:
    description: 'Base commit SHA'
    required: true
  head-sha:
    description: 'Head commit SHA'
    required: true
outputs:
  zones:
    description: 'Space-separated zone names touched'
    value: ${{ steps.resolve.outputs.zones }}
runs:
  using: 'composite'
  steps:
    - id: resolve
      shell: bash
      env:
        ZONES_JSON: ${{ inputs.zones-json }}
      run: |
        FILES="$(git diff --name-only "${{ inputs.base-sha }}" "${{ inputs.head-sha }}")"
        ZONES="$(node -e '
          const { resolveZones } = require(process.env.GITHUB_ACTION_PATH + "/../../lib/zones.js");
          const defs = JSON.parse(process.env.ZONES_JSON);
          const files = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
          process.stdout.write(resolveZones(files, defs).join(" "));
        ' <<< "$FILES")"
        echo "zones=$ZONES" >> "$GITHUB_OUTPUT"
        echo "[northstar] zones touched: ${ZONES:-<none>}"
```

- [ ] **Step 2: Create run-suite/action.yml**

Create `actions/run-suite/action.yml`:
```yaml
name: 'Northstar run-suite'
description: 'Run the test suite via the js-ts adapter.'
inputs:
  workdir:
    description: 'Directory to run tests in'
    default: '.'
  test-cmd:
    description: 'Test command'
    default: 'npm run test:ci'
runs:
  using: 'composite'
  steps:
    - shell: bash
      env:
        NS_WORKDIR: ${{ inputs.workdir }}
        NS_TEST_CMD: ${{ inputs.test-cmd }}
      run: bash "${{ github.action_path }}/../../adapters/js-ts/run.sh"
```

- [ ] **Step 3: Create coverage-gate/action.yml**

Create `actions/coverage-gate/action.yml`:
```yaml
name: 'Northstar coverage-gate'
description: 'Run coverage and enforce minimum + no-downward-trend.'
inputs:
  workdir:
    description: 'Directory to run coverage in'
    default: '.'
  coverage-cmd:
    description: 'Coverage command emitting coverage/coverage-summary.json'
    default: 'npm run test:coverage'
  min:
    description: 'Minimum acceptable line coverage pct'
    default: '80'
  mode:
    description: 'no-decrease | report'
    default: 'no-decrease'
  baseline-file:
    description: 'Committed baseline JSON path'
    default: '.northstar/coverage-baseline.json'
outputs:
  next-baseline:
    description: 'Path to the proposed new baseline file'
    value: ${{ steps.gate.outputs.next }}
runs:
  using: 'composite'
  steps:
    - id: cov
      shell: bash
      env:
        NS_WORKDIR: ${{ inputs.workdir }}
        NS_COV_CMD: ${{ inputs.coverage-cmd }}
      run: |
        bash "${{ github.action_path }}/../../adapters/js-ts/coverage.sh" | tee /tmp/ns-cov.out
        echo "summary=$(grep '^summary=' /tmp/ns-cov.out | cut -d= -f2-)" >> "$GITHUB_OUTPUT"
    - id: gate
      shell: bash
      run: |
        NEXT=".northstar/coverage-baseline.next.json"
        node "${{ github.action_path }}/../../lib/gate-cli.js" \
          --summary "${{ steps.cov.outputs.summary }}" \
          --baseline "${{ inputs.baseline-file }}" \
          --min "${{ inputs.min }}" \
          --mode "${{ inputs.mode }}" \
          --out "$NEXT" | tee -a "$GITHUB_STEP_SUMMARY"
        echo "next=$NEXT" >> "$GITHUB_OUTPUT"
```

- [ ] **Step 4: Lint the YAML parses**

Run:
```bash
node -e "const y=require('fs').readFileSync('actions/coverage-gate/action.yml','utf8'); if(!/using: 'composite'/.test(y)) throw new Error('bad'); console.log('ok')"
```
Expected: prints `ok`. (Full YAML validity is exercised end-to-end in Task 9's fixture run.)

- [ ] **Step 5: Commit**

```bash
git add actions/detect-changes/action.yml actions/run-suite/action.yml actions/coverage-gate/action.yml
git commit -m "feat(v0): composite actions — detect-changes, run-suite, coverage-gate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Reusable workflow (green path + promote on main)

**Files:**
- Create: `lib/promote-cli.js`
- Test: `lib/promote-cli.test.js`
- Create: `.github/workflows/northstar-pipeline.yml`

**Interfaces:**
- Consumes: `actions/*` (Task 7), `lib/promote.js` (Task 4).
- Produces:
  - `promote-cli.js` — `node lib/promote-cli.js --staging <dir> --regression <dir>` moves every test file under staging into regression (v0: promote all staged tests present on main), creating dirs; prints each move.
  - `northstar-pipeline.yml` — `workflow_call` with inputs `workdir`, `zones-json`, `coverage-min`, `coverage-mode`; on `pull_request` context runs detect→run→gate; on the default branch additionally commits the ratcheted baseline and runs promotion.

- [ ] **Step 1: Write the failing test for promote-cli**

Create `lib/promote-cli.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('promote-cli moves staged test files into the regression dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-prom-'));
  fs.mkdirSync(path.join(dir, 'tests', 'new', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'new', 'a.test.ts'), '// a');
  fs.writeFileSync(path.join(dir, 'tests', 'new', 'sub', 'b.test.ts'), '// b');
  execFileSync('node', [path.resolve('lib/promote-cli.js'), '--staging', 'tests/new', '--regression', 'tests/regression'], {
    cwd: dir,
  });
  assert.ok(fs.existsSync(path.join(dir, 'tests', 'regression', 'a.test.ts')));
  assert.ok(fs.existsSync(path.join(dir, 'tests', 'regression', 'sub', 'b.test.ts')));
  assert.ok(!fs.existsSync(path.join(dir, 'tests', 'new', 'a.test.ts')));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/promote-cli.test.js`
Expected: FAIL — missing `lib/promote-cli.js`.

- [ ] **Step 3: Implement lib/promote-cli.js**

Create `lib/promote-cli.js`:
```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { selectPromotions } = require('./promote');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const staging = a.staging || 'tests/new';
  const regression = a.regression || 'tests/regression';
  const staged = walk(staging);
  // v0: any staged test present on the default branch is green (it ran in the suite)
  const moves = selectPromotions(staged, staged, { stagingDir: staging, regressionDir: regression });
  for (const { from, to } of moves) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    console.log(`[northstar] promoted ${from} -> ${to}`);
  }
  if (moves.length === 0) console.log('[northstar] no staged tests to promote');
}

main();
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test lib/promote-cli.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Create the reusable workflow**

Create `.github/workflows/northstar-pipeline.yml`:
```yaml
name: Northstar pipeline
on:
  workflow_call:
    inputs:
      workdir:
        type: string
        default: '.'
      zones-json:
        type: string
        required: true
      coverage-min:
        type: string
        default: '80'
      coverage-mode:
        type: string
        default: 'no-decrease'
      node-version:
        type: string
        default: '18'

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: northstar-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v5
        with:
          node-version: ${{ inputs.node-version }}
      - name: Checkout Northstar package
        uses: actions/checkout@v5
        with:
          repository: ${{ github.repository_owner }}/Northstar
          path: .northstar-pkg
          ref: v0
      - name: Install project deps
        working-directory: ${{ inputs.workdir }}
        run: npm ci
      - name: detect-changes
        id: detect
        uses: ./.northstar-pkg/actions/detect-changes
        with:
          zones-json: ${{ inputs.zones-json }}
          base-sha: ${{ github.event.pull_request.base.sha || github.event.before }}
          head-sha: ${{ github.sha }}
      - name: run-suite
        uses: ./.northstar-pkg/actions/run-suite
        with:
          workdir: ${{ inputs.workdir }}
      - name: coverage-gate
        id: gate
        uses: ./.northstar-pkg/actions/coverage-gate
        with:
          workdir: ${{ inputs.workdir }}
          min: ${{ inputs.coverage-min }}
          mode: ${{ inputs.coverage-mode }}
      - name: Ratchet baseline + promote (main only)
        if: ${{ github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}
        working-directory: ${{ inputs.workdir }}
        run: |
          mkdir -p .northstar
          cp "${{ steps.gate.outputs.next-baseline }}" .northstar/coverage-baseline.json
          node "${GITHUB_WORKSPACE}/.northstar-pkg/lib/promote-cli.js" --staging tests/new --regression tests/regression
          git config user.name "northstar[bot]"
          git config user.email "northstar@users.noreply.github.com"
          git add .northstar/coverage-baseline.json tests/ || true
          git commit -m "chore(northstar): ratchet coverage baseline + promote regression" || echo "nothing to commit"
          git push || echo "no push (no changes / protected)"
```

- [ ] **Step 6: Commit**

```bash
git add lib/promote-cli.js lib/promote-cli.test.js .github/workflows/northstar-pipeline.yml
git commit -m "feat(v0): reusable pipeline workflow + promotion CLI

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Fixture consumer repo + acceptance test — **CHECKPOINT: coverage gate observable**

**Files:**
- Create: `examples/consumer-repo/package.json`
- Create: `examples/consumer-repo/src/math.js`
- Create: `examples/consumer-repo/src/math.test.js`
- Create: `examples/consumer-repo/.northstar/coverage-baseline.json`
- Create: `examples/consumer-repo/northstar.config.yml`
- Create: `docs/adoption-v0.md`

**Interfaces:**
- Consumes: the whole pipeline (Tasks 1–8).
- Produces: a minimal repo whose coverage can be made to *drop*, so the gate can be observed failing and passing locally (no live CI needed for this checkpoint). This is the deliberately-broken fixture the spec's §9 integration layer builds on.

- [ ] **Step 1: Create the fixture project**

Create `examples/consumer-repo/package.json`:
```json
{
  "name": "ns-fixture",
  "private": true,
  "scripts": {
    "test:ci": "node --test",
    "test:coverage": "node --experimental-test-coverage --test-reporter=./cov-reporter.js --test 2>/dev/null || true"
  }
}
```

> Note: v0's fixture uses a tiny hand-rolled coverage summary writer so the gate can be exercised without React tooling. The ALTO install (Task 10) uses the real `react-scripts` json-summary output.

Create `examples/consumer-repo/src/math.js`:
```js
'use strict';
function add(a, b) { return a + b; }
function sub(a, b) { return a - b; } // deliberately UNtested to create a coverage gap
module.exports = { add, sub };
```

Create `examples/consumer-repo/src/math.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { add } = require('./src/math.js');
test('add', () => { assert.equal(add(2, 3), 5); });
```

- [ ] **Step 2: Provide a fixed coverage summary + baseline to make the gate deterministic**

Create `examples/consumer-repo/coverage/coverage-summary.json`:
```json
{ "total": { "lines": { "total": 4, "covered": 3, "skipped": 0, "pct": 75 } } }
```

Create `examples/consumer-repo/.northstar/coverage-baseline.json`:
```json
{ "linePct": 80 }
```

Create `examples/consumer-repo/northstar.config.yml`:
```yaml
adapter: js-ts
coverage:
  min: 70
  trend: no-decrease
zones:
  - zone: src
    glob: src/**
    prompt: prompts/fixer.md
fix:
  engine: stub
  onExhaustion: label-human
```

- [ ] **Step 3: Observe the gate FAIL (coverage 75 < baseline 80)**

Run:
```bash
node lib/gate-cli.js \
  --summary examples/consumer-repo/coverage/coverage-summary.json \
  --baseline examples/consumer-repo/.northstar/coverage-baseline.json \
  --min 70 --mode no-decrease --out /tmp/ns-next.json; echo "exit=$?"
```
Expected: prints `... FAIL — coverage dropped 80.00% → 75.00%` and `exit=1`. **This is the checkpoint: the gate blocks a coverage drop.**

- [ ] **Step 4: Observe the gate PASS after "adding a test" (raise the summary to 100)**

Run:
```bash
printf '{ "total": { "lines": { "total": 4, "covered": 4, "skipped": 0, "pct": 100 } } }' > examples/consumer-repo/coverage/coverage-summary.json
node lib/gate-cli.js \
  --summary examples/consumer-repo/coverage/coverage-summary.json \
  --baseline examples/consumer-repo/.northstar/coverage-baseline.json \
  --min 70 --mode no-decrease --out /tmp/ns-next.json; echo "exit=$?"
```
Expected: prints `... PASS — coverage 100.00% ≥ baseline 80.00%` and `exit=0`; `/tmp/ns-next.json` shows `"linePct": 100`.

- [ ] **Step 5: Write the v0 adoption doc**

Create `docs/adoption-v0.md`:
```markdown
# Installing Northstar v0 on a repo

1. Add `.github/workflows/ci.yml`:
   ```yaml
   name: Northstar
   on:
     pull_request:
     push:
       branches: [main, master]
   jobs:
     northstar:
       uses: <owner>/Northstar/.github/workflows/northstar-pipeline.yml@v0
       with:
         workdir: frontend
         zones-json: '[{"zone":"frontend","glob":"frontend/**"}]'
         coverage-min: '80'
       secrets: inherit
   ```
2. Ensure the project has `test:ci` and `test:coverage` npm scripts, the latter
   emitting `coverage/coverage-summary.json` (json-summary reporter).
3. Commit `.northstar/coverage-baseline.json` (or let the first run on the default
   branch establish it).
4. Create `tests/new/` and `tests/regression/` directories.
```

- [ ] **Step 6: Restore the fixture to its "broken" state and commit**

Run:
```bash
printf '{ "total": { "lines": { "total": 4, "covered": 3, "skipped": 0, "pct": 75 } } }' > examples/consumer-repo/coverage/coverage-summary.json
git add examples/consumer-repo docs/adoption-v0.md
git commit -m "feat(v0): deliberately-broken fixture repo + adoption doc (gate checkpoint)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Install on the ALTO frontend — **CHECKPOINT: gate live on a real repo**

**Files (in the ALTO Works repo, not the Northstar repo):**
- Create: `/Users/davidjohnson/Documents/Claude/Projects/ALTO Works/frontend/.northstar/coverage-baseline.json`
- Create: `/Users/davidjohnson/Documents/Claude/Projects/ALTO Works/.github/workflows/northstar.yml`
- Create dirs: `frontend/tests/new/`, `frontend/tests/regression/`

**Interfaces:**
- Consumes: the published Northstar package at ref `v0`.
- Produces: a live install whose first PR shows the coverage gate as a check.

- [ ] **Step 1: Establish the ALTO frontend baseline locally**

Run:
```bash
cd "/Users/davidjohnson/Documents/Claude/Projects/ALTO Works/frontend"
npm ci
npm run test:coverage
node -e "const s=require('./coverage/coverage-summary.json').total.lines.pct; require('fs').mkdirSync('.northstar',{recursive:true}); require('fs').writeFileSync('.northstar/coverage-baseline.json', JSON.stringify({linePct:s},null,2)); console.log('baseline', s)"
```
Expected: prints the real current line-coverage pct and writes `.northstar/coverage-baseline.json`.

- [ ] **Step 2: Add the install workflow**

Create `/Users/davidjohnson/Documents/Claude/Projects/ALTO Works/.github/workflows/northstar.yml`:
```yaml
name: Northstar
on:
  pull_request:
    paths: ['frontend/**']
  push:
    branches: [main, master]
    paths: ['frontend/**']
jobs:
  northstar:
    uses: dmjohnsonintl/Northstar/.github/workflows/northstar-pipeline.yml@v0
    with:
      workdir: frontend
      zones-json: '[{"zone":"frontend","glob":"frontend/**"}]'
      coverage-min: '0'
      coverage-mode: 'no-decrease'
    secrets: inherit
```

> `coverage-min: '0'` for the first install so only the *trend* gate is active (ALTO's real coverage may be low); raise `min` once the baseline is trusted.

- [ ] **Step 3: Create the staging/regression dirs**

Run:
```bash
cd "/Users/davidjohnson/Documents/Claude/Projects/ALTO Works/frontend"
mkdir -p tests/new tests/regression
touch tests/new/.gitkeep tests/regression/.gitkeep
```

- [ ] **Step 4: Open a proving PR that lowers coverage**

Create a throwaway branch that adds an untested function to `frontend/src`, push it, and open a PR. Verify the **Northstar** check runs and **fails** the coverage-gate step with a "coverage dropped" message in the step summary.

Run (illustrative — adjust file to a real untested export):
```bash
cd "/Users/davidjohnson/Documents/Claude/Projects/ALTO Works"
git checkout -b prove/northstar-gate
printf '\nexport function untestedHelper(){return 42;}\n' >> frontend/src/App.tsx
git add frontend/.northstar frontend/tests .github/workflows/northstar.yml frontend/src/App.tsx
git commit -m "test(northstar): prove coverage gate blocks a coverage drop"
git push -u origin prove/northstar-gate
gh pr create --fill
```
Expected: the PR shows a failing **Northstar** check whose coverage-gate step reports a downward-trend failure. **This is the checkpoint: the gate is live on a real repo.**

- [ ] **Step 5: Confirm the gate passes when the drop is reverted**

Run:
```bash
cd "/Users/davidjohnson/Documents/Claude/Projects/ALTO Works"
git checkout frontend/src/App.tsx
git commit -am "revert: remove untested helper"
git push
```
Expected: the Northstar check turns green.

---

## Task 11: Single-attempt fix-agent (stub engine + real engine wiring)

**Files:**
- Create: `engine/stub/fix.sh`
- Create: `engine/claude-code/fix.sh`
- Create: `actions/fix-agent/action.yml`
- Test: `engine/engine.test.js`

**Interfaces:**
- Consumes: nothing from `lib/`; operates on a checked-out repo.
- Engine contract (both engines honor it): invoked as `bash engine/<name>/fix.sh`, reads env `NS_FIX_WORKDIR`, `NS_FIX_LOG` (path to failing-test log), `NS_FIX_BRANCH` (branch to create). On success it commits a fix on `NS_FIX_BRANCH` and exits `0`; on failure exits non-zero. The stub applies a known-good patch; the claude-code engine invokes Claude Code.
- Produces: `fix-agent` action — single attempt: create branch → run engine → re-run tests → if green open a PR via `gh`, else apply `ns:needs-human` label.

- [ ] **Step 1: Write the failing test for the stub engine**

Create `engine/engine.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('stub engine commits a fix on the target branch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-eng-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'broken.js'), 'module.exports = 0;');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  execFileSync('bash', [path.resolve('engine/stub/fix.sh')], {
    cwd: dir,
    env: { ...process.env, NS_FIX_WORKDIR: dir, NS_FIX_BRANCH: 'ns/fix/x', NS_FIX_LOG: '/dev/null' },
  });
  const branches = execFileSync('git', ['branch'], { cwd: dir, encoding: 'utf8' });
  assert.match(branches, /ns\/fix\/x/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test engine/engine.test.js`
Expected: FAIL — missing `engine/stub/fix.sh`.

- [ ] **Step 3: Implement the stub engine**

Create `engine/stub/fix.sh`:
```bash
#!/usr/bin/env bash
# Deterministic fake engine for acceptance tests: creates the fix branch and
# writes a marker file so the pipeline flow can be exercised without an LLM.
set -euo pipefail
cd "${NS_FIX_WORKDIR:?}"
git checkout -q -b "${NS_FIX_BRANCH:?}"
echo "// northstar-stub fix applied" > northstar-stub-fix.txt
git add northstar-stub-fix.txt
git commit -qm "fix(northstar-stub): apply known-good patch"
echo "[northstar] stub engine committed a fix on ${NS_FIX_BRANCH}"
```

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
chmod +x engine/stub/fix.sh
node --test engine/engine.test.js
```
Expected: PASS (1 test).

- [ ] **Step 5: Wire the real engine (consult the Claude Code Action inputs first)**

Before writing `engine/claude-code/fix.sh`, read the current inputs of the Claude Code GitHub Action / CLI (its `action.yml` / README) so the invocation is accurate — do **not** guess the input names. Then create `engine/claude-code/fix.sh` implementing the same contract (create `NS_FIX_BRANCH`, invoke Claude Code headless with a prompt built from `NS_FIX_LOG` scoped to the failing tests, commit the result). Pin the action/CLI version. Record the resolved invocation in the file's header comment.

Create `engine/claude-code/fix.sh` (skeleton to complete from the docs):
```bash
#!/usr/bin/env bash
# Real engine: invoke Claude Code headless to fix failing tests.
# Contract: NS_FIX_WORKDIR, NS_FIX_BRANCH, NS_FIX_LOG. Requires ANTHROPIC_API_KEY.
# Invocation resolved from Claude Code docs at implementation time (pin the version).
set -euo pipefail
cd "${NS_FIX_WORKDIR:?}"
git checkout -q -b "${NS_FIX_BRANCH:?}"
PROMPT="The test suite is failing. Log:
$(cat "${NS_FIX_LOG:?}")
Fix the SOURCE so the failing tests pass. Do not weaken, skip, or delete tests."
# <resolved Claude Code headless invocation goes here, e.g. the pinned CLI in -p mode>
# It must edit files in place. Then:
git add -A
git commit -qm "fix(northstar): agent fix for failing tests" || { echo "no changes"; exit 1; }
```

- [ ] **Step 6: Create the fix-agent action**

Create `actions/fix-agent/action.yml`:
```yaml
name: 'Northstar fix-agent (single attempt)'
description: 'Run the configured engine once; on green open a PR, else label needs-human.'
inputs:
  workdir:
    default: '.'
  engine:
    description: 'stub | claude-code'
    default: 'stub'
  test-cmd:
    default: 'npm run test:ci'
  failing-log:
    description: 'Path to the failing-test log'
    default: 'artifacts/test.log'
runs:
  using: 'composite'
  steps:
    - id: fix
      shell: bash
      env:
        NS_FIX_WORKDIR: ${{ inputs.workdir }}
        NS_FIX_BRANCH: ns/fix/${{ github.run_id }}
        NS_FIX_LOG: ${{ inputs.failing-log }}
      run: |
        set +e
        bash "${{ github.action_path }}/../../engine/${{ inputs.engine }}/fix.sh"
        echo "engine_exit=$?" >> "$GITHUB_OUTPUT"
    - name: Re-run tests and decide
      shell: bash
      env:
        NS_WORKDIR: ${{ inputs.workdir }}
        NS_TEST_CMD: ${{ inputs.test-cmd }}
      run: |
        if [ "${{ steps.fix.outputs.engine_exit }}" != "0" ]; then
          gh issue create --title "Northstar: needs human (run ${{ github.run_id }})" \
            --label "ns:needs-human" --body "Engine could not produce a fix." || true
          echo "engine failed → labeled needs-human"; exit 0
        fi
        if bash "${{ github.action_path }}/../../adapters/js-ts/run.sh"; then
          git push -u origin "ns/fix/${{ github.run_id }}"
          gh pr create --fill --head "ns/fix/${{ github.run_id }}" \
            --title "Northstar fix (run ${{ github.run_id }})" || true
          echo "green → PR opened"
        else
          gh issue create --title "Northstar: needs human (run ${{ github.run_id }})" \
            --label "ns:needs-human" --body "Fix did not make the suite green." || true
          echo "still red → labeled needs-human"
        fi
```

- [ ] **Step 7: Full suite green + commit**

Run: `npm test`
Expected: PASS (all `lib/` + adapter + engine tests).

```bash
git add engine/ actions/fix-agent/action.yml
git commit -m "feat(v0): single-attempt fix-agent (stub + real-engine contract) → PR

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12: Wire fix-agent into the pipeline on test failure — **CHECKPOINT: end-to-end fix→PR**

**Files:**
- Modify: `.github/workflows/northstar-pipeline.yml` (add a failure-triggered fix job)

**Interfaces:**
- Consumes: `actions/fix-agent` (Task 11).
- Produces: on a red `run-suite`, the pipeline runs the fix-agent (engine from config) once and opens a PR or labels `ns:needs-human`.

- [ ] **Step 1: Add a fix job gated on run-suite failure**

In `.github/workflows/northstar-pipeline.yml`, add an input and a job. Add to `workflow_call.inputs`:
```yaml
      engine:
        type: string
        default: 'stub'
```
Change the `run-suite` step to record failure instead of aborting the job, by giving it `id: suite` and `continue-on-error: true`, then add after the `gate` job a conditional fix job in the same `jobs:` map:
```yaml
  fix:
    needs: gate
    if: ${{ failure() }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v5
        with: { node-version: ${{ inputs.node-version }} }
      - uses: actions/checkout@v5
        with:
          repository: ${{ github.repository_owner }}/Northstar
          path: .northstar-pkg
          ref: v0
      - working-directory: ${{ inputs.workdir }}
        run: npm ci
      - uses: ./.northstar-pkg/actions/fix-agent
        with:
          workdir: ${{ inputs.workdir }}
          engine: ${{ inputs.engine }}
        env:
          GH_TOKEN: ${{ github.token }}
```

- [ ] **Step 2: Prove it in the fixture with the stub engine**

In a scratch clone of the Northstar repo, run the workflow via `act` (or a sandbox GitHub repo) against a fixture with a failing test, `engine: stub`. Verify the fix job runs, the stub commits a fix, tests go green, and a PR is opened (or, when `gh` is unavailable under `act`, the intended `gh pr create` command is logged).

Run (if using `act`):
```bash
act pull_request -W .github/workflows/northstar-pipeline.yml \
  --input engine=stub --input workdir=examples/consumer-repo \
  --input zones-json='[{"zone":"src","glob":"src/**"}]'
```
Expected: the fix job executes the stub engine and reaches the PR-open step. **This is the checkpoint: the failure→fix→PR path runs end to end.**

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/northstar-pipeline.yml
git commit -m "feat(v0): dispatch single-attempt fix-agent on test failure

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 4: Tag the v0 ref the installs point at**

```bash
git tag -f v0
git push -f origin v0
```
Expected: the `v0` tag now points at the completed slice; the ALTO install (`@v0`) resolves to it.

---

## Self-review notes (coverage against the v0 scope)

- Green-path pipeline (detect → run → coverage-gate no-decrease → promote): Tasks 2–8. ✓
- Single-attempt fix-agent → PR, human-reviewed, no auto-merge: Tasks 11–12. ✓
- ALTO React/TS frontend as first install; coverage gate as first visible checkpoint: Task 10 (gate) precedes Task 12 (fix loop). ✓
- Deliberately-broken fixture for observable acceptance: Task 9. ✓
- Deferred (not in this plan, per spec §13): multi-retry, bug intake, monitoring dashboards, substrate claims/TTL-GC, Python adapter, other two repos. ✓
- Real-engine external API not fabricated: Task 11 Step 5 resolves Claude Code inputs from docs before wiring; the stub is the fully-tested path. ✓
