# Design: Runner Breadth — unit runners (Jest/Vitest) + system-test layer (Playwright)

**Date:** 2026-07-20
**Status:** Approved (brainstorm) — awaiting spec review before writing the implementation plan
**Repo:** `dmjohnsonintl/northstar-ci` (canonical code repo)
**Spec area:** Roadmap item "runner breadth" (spec §14 remaining v1/v1.1 work)

## Goal

Prove and broaden the runners Northstar supports, in one slice:

1. **Unit runner breadth** — prove the js-ts adapter works across all three unit
   runners consumers actually use: `node:test` (already proven), **Jest**, and **Vitest**.
2. **System-test layer** — add a first-class Playwright (E2E/system) stage to the
   pipeline that runs, quarantines flakes, routes deterministic failures to a
   layer-aware fix-agent with a human backstop, and **promotes green E2E tests
   into the immutable regression suite**.

## Key finding that shapes the design

The **js-ts adapter is already runner-agnostic.** `adapters/js-ts/run.sh` runs
`NS_TEST_CMD` (default `npm run test:ci`) and `adapters/js-ts/coverage.sh` reads
`coverage/coverage-summary.json` — the Istanbul **json-summary** shape. Jest and
Vitest both emit that exact file natively (`--coverage` with the `json-summary`
reporter). So "Jest/Vitest support" is a **proof-and-fixtures** task, not new
adapter code. Playwright, by contrast, is a *system* layer: it produces no unit
line-coverage and must not feed the coverage gate — that is genuinely new pipeline
surface.

Two existing pieces make Piece B cheaper than it looks:
- `lib/promote-cli.js` is **already parametric** on `--staging`/`--regression` dirs.
- `actions/fix-agent` already takes `test-cmd` + `failing-log`, so it is
  **mechanically layer-agnostic** — pointing it at the E2E command and E2E log
  already makes it operate on the system layer.

---

## Piece A — Unit runner breadth (Jest + Vitest)

**No adapter code changes.** Proof via fixtures + demo caller workflows, matching
the existing `pydemo`/`bugdemo` pattern (a fixture + a caller that runs the full
pipeline green in CI).

### Fixtures

- `examples/jestdemo/` — minimal package.
  - Jest configured with `coverageReporters: ['json-summary']` so `--coverage`
    emits `coverage/coverage-summary.json`.
  - Scripts: `test:ci` (run tests, no coverage) and `test:coverage` (with coverage).
  - `.northstar/coverage-baseline.json` seeded so the coverage gate has a baseline.
- `examples/vitedemo/` — same shape, Vitest.
  - `vitest run --coverage`, provider `v8`, `coverage.reporter: ['json-summary']`.
  - Same `test:ci` / `test:coverage` scripts + seeded baseline.

Both fixtures carry a real source module + a passing test so the gate sees a real
suite and real coverage.

### Proof

- `.github/workflows/jestdemo.yml` and `.github/workflows/vitedemo.yml` — dispatch
  (+ optionally push-path-filtered) callers that invoke `northstar-pipeline.yml@v0`
  against each fixture with `adapter: js-ts` and the runner-specific
  `install-cmd`/`test-cmd`/`coverage-cmd`. Success in CI is the proof that all three
  unit runners satisfy the coverage-summary contract.

The demo caller (running the whole pipeline green) is the **primary** proof, exactly
as for the existing adapters. A formal contract-harness entry for Jest/Vitest is
**not** added here — the contract fixtures deliberately avoid installing heavy test
frameworks into their per-run tmp dirs, and the runner-agnostic `run.sh`/`coverage.sh`
contract is already exercised. (Follow-up, out of scope: fold Jest/Vitest into the
contract harness if we want per-commit regression protection independent of CI demos.)

---

## Piece B — Playwright system-test layer

### Placement: a new `system` job in `northstar-pipeline.yml`

- `needs: gate`
- `if: ${{ always() && needs.gate.result == 'success' && inputs.system-tests }}`

Runs **only** when unit + coverage passed **and** E2E is opted in — test-pyramid
ordering, so no browser minutes are spent when units are red.

### New reusable-workflow inputs

- `system-tests` — boolean, **default `false`** (most repos have no E2E; must be
  explicitly opted in).
- `system-test-cmd` — string, default `npx playwright test`.

When `system-tests` is true, the `system` job sets up Node (and Python if
`adapter: python`), installs project deps, and installs browsers with
`npx playwright install --with-deps chromium` before running.

### Run + flake quarantine

The `system` job runs the E2E suite via the **existing `run-suite` action** with
`test-cmd: <system-test-cmd>` and `retries: 1`, reusing retry-once flake detection
(browser tests flake more than units):

- fail → pass = **flaky** ⇒ `run-suite` exits 0, job stays green, emit
  `ns:signal/flaky` with `role: system`. Quarantined, never routed to a fixer.
- both attempts fail = **deterministic failure** ⇒ the job exposes
  `suite-failed: true` (same output shape as the `gate` job).

### Layer-aware fix + human backstop: a new `fix-system` job

Mirrors the existing `fix` job:

- `needs: system`
- `if: ${{ always() && needs.system.outputs.suite-failed == 'true' }}`
- Steps: checkout (E2E branch/ref) → setup + install → resolve primary zone →
  **acquire zone claim** (`actions/claim`, `role: fixer`) → queue-guard on
  `acquired != 'true'` → capture E2E log (`run-suite`, `retries: 0`,
  `test-cmd: <system-test-cmd>`) → **fix-agent** (`test-cmd: <system-test-cmd>`,
  `failing-log: <workdir>/artifacts/test.log`, `layer: system`, engine,
  `pr-title: Northstar system-test fix`) → **release claim** (`always()`).

The fix-agent's existing behavior **is** "try, then escalate to a human": green ⇒
open a PR (human review, never auto-merge); still red after one attempt ⇒ label
`ns:needs-human`. Combined with `run-suite`'s retry-once quarantine upstream, the
end-to-end behavior is: **retry the flake, auto-fix a deterministic failure once,
escalate to a human on exhaustion.**

**No claim collision** with the unit `fix` job: within a single pipeline run they
are mutually exclusive — a unit failure makes the `gate` job red, which skips the
`system` job (its `if` requires `gate.result == 'success'`), so `fix-system` never
runs alongside `fix`. Claims stay zone-only (no zone×layer claim key needed yet).

### Layer awareness (advisory)

`actions/fix-agent` gains a `layer` input (default `unit`), passed to the engine as
`NS_FIX_LAYER`:

- `engine/claude-code/fix.sh` reads `NS_FIX_LAYER` and, when `system`, adds one line
  of prompt framing (e.g. "these are end-to-end/system tests; the failure may be a
  selector, a wait/timing issue, or a real product regression").
- `engine/stub/fix.sh` ignores it.

This marks the `zone × layer` seam from the spec without building a separate
specialized agent (deferred until real E2E-failure transcripts exist — e.g. from the
nightly canary — to inform what specialization actually helps).

---

## Promotion refactor (one canonical action)

Extend `actions/promote-regression` so both unit and E2E promotion share one
implementation:

- New inputs `staging` (default `tests/new`) and `regression` (default
  `tests/regression`).
- `next-baseline` becomes **optional**: when empty, skip the coverage-baseline copy
  and only promote staged → regression. (`lib/promote-cli.js` is already dir-parametric.)

Behavior:

- **Unit promotion** — the existing step in the `gate` job is unchanged in effect
  (uses the defaults + `next-baseline`).
- **E2E promotion** — a step in the `system` job, guarded
  `if: ${{ system green && github.ref == default branch }}`, calls
  `promote-regression` with `staging: e2e/new`, `regression: e2e/regression`, and no
  `next-baseline` (no coverage ratchet). Green E2E tests move into the immutable
  regression suite.

This keeps promotion co-located with the job that proved the layer green (same
mental model as unit promotion) and reuses the same checkout/permissions.

---

## Fixtures, proof & tests

- `examples/e2edemo/` — minimal app + Playwright config + a passing E2E test + a
  staged `e2e/new/` test to prove promotion.
- `.github/workflows/e2edemo.yml` — caller with `system-tests: true`,
  `system-test-cmd`, on the default branch, proving **run → pass → promote** green in
  CI. The fix path is proven with the **stub** engine (deterministic, no API spend —
  consistent with `fixdemo` and the `engine` default). Proving the *real* engine on
  an E2E failure belongs to the §12.1 nightly canary (scheduled, budgeted cost), not
  a per-push demo.
- Unit tests: extend `lib/promote.test.js` for the parametric `staging`/`regression`
  + optional-baseline path. This is the only new **lib** logic — the rest of Piece B
  is workflow/action wiring proven by the CI demo.

## Docs

- New `docs/system-tests.md` — consumer opt-in: `system-tests: true`,
  `system-test-cmd`, the `e2e/new` staging dir, and the promotion behavior.
- `SECURITY.md` — note the system-test layer runs consumer E2E code (already the case
  for unit tests) and that E2E fixes, like all fixes, are human-review-only PRs.

## Explicitly out of scope (named follow-ups)

- A formal **E2E adapter-contract method** — E2E reuses `run.sh` via `run-suite`, so
  no new adapter script; a system-layer conformance check can be added later.
- **Real-engine** proof of an E2E fix — deferred to the §12.1 nightly canary.
- A **genuinely separate `zone × layer` specialized fix-agent** — deferred until
  there is evidence (real E2E-failure transcripts) about what specialization helps.
- Folding Jest/Vitest into the **contract harness** for per-commit regression
  protection independent of the CI demos.

## Acceptance criteria

1. `jestdemo.yml` and `vitedemo.yml` run the full pipeline green in CI (all three
   unit runners proven against the coverage-summary contract).
2. `e2edemo.yml` runs the `system` job green: Playwright E2E runs, passes, and green
   E2E tests are promoted (`e2e/new` → `e2e/regression`) on the default branch.
3. A deterministic E2E failure routes through `fix-system` (claim → capture → fix →
   release) and, unfixed, escalates to `ns:needs-human`; a flaky E2E failure is
   quarantined (`ns:signal/flaky`, role=system) and does not route.
4. Unit promotion behavior is unchanged; `promote-regression` supports the parametric
   staging/regression + optional-baseline path with unit-test coverage.
5. `system-tests` defaults to false; a repo that does not opt in sees no new jobs run.
