# Design: nightly canary + §12.1 alerting

**Date:** 2026-07-22
**Status:** Approved (brainstorm) — awaiting spec review before writing the implementation plan
**Repo:** `dmjohnsonintl/northstar-ci` (canonical code repo)
**Spec area:** Spec §12.1 "Agent / model health (drift detection)" — the nightly canary and the alerting rule set (§14 remaining v1/v1.1 work, item 3)

## Goal

Answer a question no other Northstar signal answers: **is the AI itself still doing
good work?** Pipeline health tells you whether a client's gate is green. It does not
tell you whether the model has quietly regressed — because a client with no failures
generates no fix-agent traffic, and a client whose fixes silently degrade looks the
same as one with harder bugs.

The canary removes that ambiguity by running the **real engine against a fixture with
a known bug and a known-good outcome** on a schedule. A red canary is an unambiguous
"the model stopped working" signal, independent of any client's traffic. Around it,
this slice adds the four §12.1 alert rules so degradation *finds you* rather than
waiting to be noticed on a dashboard.

## Scoping insight

Most of the canary already exists. `examples/aidemo` is a deterministic broken
fixture (`sum()` returns `a - b`, with a test asserting `5` and `30`), and
`aidemo.yml` already invokes the real `claude-code` engine against it via
`northstar-pipeline.yml`. What is missing is: a **schedule**, a **trustworthy
verdict**, **debris cleanup**, and the **alerting** that turns a verdict into a page.

Likewise, `lib/metrics.js:147` already declares the destination field:

```js
canary: events.canary || null, // 'green' | 'red' | null
```

The read-model seam was designed for this and left unpopulated. This slice fills it
rather than building a parallel reporting path.

## Key facts grounding the design

- `northstar-metrics.yml` already gathers `runs.json` (via `gh run list` with
  `workflowName` + `conclusion`), `coverage.json`, `agent.json`, and `extra.json`,
  and already holds `contents: write` + `issues: write`. Three of the four alert
  rules need exactly those inputs and no new permission.
- `lib/metrics.js` is a PURE read-model with time injected via `now`, never
  `Date.now()`. Absent data renders `—`, never a fabricated zero (`costFromRecords`
  sets the precedent: a null-cost run counts as a run but never as `$0`). This slice
  preserves that discipline.
- `lib/substrate.js` already owns starvation math — `isStarved(claim, { now,
  starvationThresholdSeconds })`, default `21600`. The claim-age alert reuses it
  rather than duplicating the threshold logic.
- A reusable workflow may call another reusable workflow (nesting is permitted up to
  four levels), so `northstar-canary.yml` can call `northstar-pipeline.yml` directly.
- The `fix` job's success does **not** by itself prove the model worked: a run that
  escalates to `ns:needs-human` can still conclude `success`. A verdict read from the
  run conclusion is only trustworthy if the workflow explicitly asserts the outcome.
- A reusable workflow requesting a permission the caller did not grant **fails to
  start** with no API-visible error (the ALTO gotcha). Consumer permission
  requirements must be documented, not silently assumed.

## Decision: verdict is the canary run's conclusion

Chosen over writing a canary record to the `northstar-metrics` branch or committing a
status file to `main`. Rationale: `gh run list` already carries `workflowName` and
`conclusion`, so the verdict is a trace the system emits for free. No new storage, no
second writer on the metrics branch, no nightly commit to `main`, and the design stays
a pure read-model over traces. Real cost data lands automatically as a side effect,
because the canary is a genuine `claude-code` fix run and `fix-agent` already writes a
per-run cost record.

The cost of this choice — the conclusion must actually mean something — is paid by the
`assert` job below.

---

## 1. `northstar-canary.yml` (new reusable workflow)

`workflow_call`, so clients install it the same way as every other stage.

### Inputs

| Input | Type | Default | Meaning |
|---|---|---|---|
| `fixture-dir` | string | `examples/aidemo` | Workdir holding the known-broken fixture |
| `zones-json` | string | `[{"zone":"src","glob":"src/**"}]` | Passed through to the pipeline |
| `engine` | string | `claude-code` | The engine under test |
| `coverage-min` | string | `0` | Fixture is about the fix loop, not coverage |
| `cleanup-pr` | boolean | `true` | Close + delete the PR the canary produces |

`secrets: inherit` carries `ANTHROPIC_API_KEY` to the engine.

### Jobs

| Job | Responsibility |
|---|---|
| `canary` | Calls `northstar-pipeline.yml` with the fixture, `engine`, and `coverage-min`. |
| `assert` | Fails unless the fix-agent produced a **green suite** *and* **opened a PR**. This is what makes the run conclusion a trustworthy verdict. |
| `cleanup` | `if: always() && inputs.cleanup-pr` — closes the run's `ns/fix/*` PR and deletes the branch. Non-fatal in-shell (`exit 0`), so cleanup can never change the verdict. |

`cleanup` runs on red runs too, so a failed canary leaves no branch or claim behind.

### Why `assert` is a separate job

Without it, an escalating run concludes `success` and the dashboard reports green
while the model has actually failed — the exact false-negative the canary exists to
prevent. `assert` converts "the workflow ran" into "the model still works."

---

## 2. `canarydemo.yml` (new scheduled caller)

The dogfood install, and the reference snippet for clients:

```yaml
name: Northstar canary
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
    secrets: inherit
```

The workflow's `name:` is what `gh run list` reports as `workflowName`, so it is also
the default value of the metrics `canary-workflow` input. The two must agree; the
acceptance criteria assert it.

---

## 3. `lib/metrics.js` (edit): projection only

One new pure export, plus wiring:

```js
canaryFromRuns(runs, { workflowName }) -> 'green' | 'red' | null
```

Most recent run of that workflow: `success` → `green`, `failure` → `red`, no such run
or still pending → `null`. `null` is a real outcome meaning *unknown*, never coerced
to red — an absent canary is not evidence of a broken model.

`agentHealth` already accepts `events.canary`; the caller now supplies it.
`renderDashboard` gains an **Agent/model health** line for the canary and an
**Alerts** section listing currently-firing rules.

Thresholding deliberately does **not** live here. Projection (what GitHub's payload
means) and policy (what counts as bad) stay in separate modules, so retuning a
threshold never touches payload-shape code and the alert tests never need a realistic
`gh` payload.

---

## 4. `lib/alerts.js` (new): the rule engine

PURE, time injected, no I/O:

```js
evaluateAlerts(model, thresholds, { now }) -> [
  { rule, state: 'firing' | 'clear', severity, title, body }
]
```

### The four rules

| Rule | Reads | Fires when | Severity |
|---|---|---|---|
| `canary` | `agentHealth.canary` | `'red'` | `page` |
| `escalation-rate` | `agentHealth` opened vs. escalations | rate > `escalationRate` | `trend` |
| `coverage-trend` | `coverageSeries.deltaFromPrev` | delta < `coverageDeltaMin` | `trend` |
| `claim-starvation` | claim ages from `ns/claim/*` | max age > `starvationThresholdSeconds` (via `substrate.isStarved`) | `trend` |

### Three states, not two

Every rule returns `firing` **or** `clear` — or is **omitted entirely** when its input
is missing. Omission is what prevents fabricated verdicts: no canary run in the window
→ `canary: null` → the rule is skipped, neither firing nor clear. An empty coverage
series behaves the same. The `clear` state is what allows a recovered alert to be
closed rather than alerts only ever accumulating.

---

## 5. `lib/alerts-cli.js` (new)

Thin I/O shell, matching `metrics-cli.js`:

```
node lib/alerts-cli.js --runs runs.json --coverage coverage.json \
  --agent agent.json --claims claims.json --now <ISO> \
  --escalation-rate 0.5 --coverage-delta-min 0 --claim-age-seconds 21600 \
  --canary-workflow 'Northstar canary'
```

Emits a JSON array of decisions on stdout for the workflow to act on.

---

## 6. `northstar-metrics.yml` (edit): gather, evaluate, act

Three changes:

1. **Gather claim ages.** The workflow currently only counts `ns/claim/*` branches. It
   now also reads each claim body so ages are available: `git ls-remote --heads origin
   'ns/claim/*'` enumerates the refs, and for each one `git archive origin/ns/claim/<zone>
   .northstar/claims/<zone>.json` extracts the claim JSON that `actions/claim` wrote
   there. Same `git archive` technique already used for cost records, and guarded the
   same way — an unreadable claim is skipped, not fatal. Result is `claims.json`.
2. **Evaluate.** Run `alerts-cli.js`; render the results into the dashboard and the
   step summary unconditionally.
3. **Act.** Apply the issue lifecycle below — only when `alerts: true`.

### Issue lifecycle

Each rule owns a stable title `Northstar alert: <rule>`, labeled `ns:alert` plus
`ns:alert/page` or `ns:alert/trend`.

| Decision | Existing **open** issue? | Action |
|---|---|---|
| `firing` | no | `gh issue create` with title, body, labels |
| `firing` | yes | `gh issue comment` — still firing, current numbers |
| `clear` | yes | comment recovery numbers, then `gh issue close` |
| `clear` | no | nothing — no noise for a rule that was never unhappy |

Dedup is a title search over **open** issues, the pattern the daily digest already
uses. A rule that fires again after closing opens a **fresh** issue, so each issue is
one contiguous incident with its own timeline.

### New inputs

| Input | Default | Meaning |
|---|---|---|
| `alerts` | `true` | Master switch for **writing issues** |
| `escalation-rate` | `0.5` | >50% of fix attempts escalating |
| `coverage-delta-min` | `0` | Any negative movement fires |
| `claim-age-seconds` | `21600` | Substrate's own starvation default |
| `canary-workflow` | `Northstar canary` | Workflow name to read the verdict from |
| `alert-label` | `ns:alert` | Base label |

`alerts` defaults to `true` because a Northstar install that never tells you anything
is the failure mode this slice exists to fix. `alerts: false` still renders alert
state to the dashboard and step summary and suppresses only issue writes — the
documented opt-out for a client evaluating Northstar before they want it filing
issues in their own tracker.

---

## 7. Error handling

Three named failure modes, each with an explicit answer:

1. **Missing data never fabricates a verdict.** Rules with absent inputs are skipped,
   not defaulted. Consistent with `costFromRecords` never rendering a fake `$0`.
2. **A failed alert write never blacks out the dashboard.** Issue actions run *after*
   the dashboard commit and are individually non-fatal, mirroring the existing guard
   on the cost-record gather.
3. **The canary cannot spend unbounded budget.** It inherits the pipeline's bounded
   retry limit, and `cleanup` is `if: always()`, so a hung engine leaves no claim,
   branch, or open PR behind.

---

## 8. Testing

`lib/alerts.js` is pure with injected time, so `lib/alerts.test.js` covers **per rule**:
firing, clear, and skipped-for-missing-data — plus the transition pairs
(firing→clear, clear→firing), because the issue lifecycle depends on them.
`canaryFromRuns` is tested for green, red, null-when-absent, and null-when-pending.

This branch coverage is deliberate. The `run-suite` bug (2026-07-20, commit `9c47b0b`)
existed for two days because a branchy shell path was proven only by a live demo that
happened to exercise one branch. Alert state is branchy in exactly the same way.

The workflows get demo-proof rather than unit tests, per existing practice.

---

## 9. Proof

- `canarydemo.yml` on `workflow_dispatch`: real engine fixes `examples/aidemo`,
  `assert` passes, `cleanup` closes the PR and deletes the branch, run concludes
  `success`.
- A deliberately-unfixable variant (or a forced `assert` failure) concludes `failure`
  → next metrics run renders `canary: red` and opens `Northstar alert: canary`.
- Re-running green → the metrics run comments recovery and **closes** that issue.
- The dashboard's Cost line shows a real dollar figure from the canary's cost record.

---

## 10. Scope boundaries (YAGNI)

In scope: the canary workflow, its scheduled caller, the four §12.1 alert rules, the
issue lifecycle, dashboard rendering, docs.

## Explicitly out of scope (named follow-ups)

- **Per-role canaries** (`engine.models` route/author/fix tiers validated
  separately) — one engine role is instrumented today.
- **Guard-trip rate** (§7.3 diff-guard rejections) — the diff-guard is not built, so
  the trace does not exist.
- **Retries-to-green / cost-per-fix trend lines** — the records now exist; charting
  them is separate.
- **Tier 2 external exporters** (OTel/CloudWatch/Datadog) — alerting stays on GitHub
  primitives in this slice.
- **Alert issue retention/pruning** — shares the deferred retention question with the
  cost-record stream.
- **Non-`aidemo` fixtures** (Python canary, E2E canary) — the workflow is
  fixture-parametric, so these are configuration, not code.

---

## Acceptance criteria

1. `northstar-canary.yml` is a `workflow_call` reusable; `canarydemo.yml` calls it on
   a nightly cron and on dispatch.
2. The canary's `assert` job fails when the fix-agent escalates instead of fixing —
   verified, not assumed.
3. `cleanup` leaves no open `ns/fix/*` PR and no leftover branch, on both green and
   red runs.
4. `canaryFromRuns` returns `null` (never `red`) when no canary run exists.
5. The `name:` of `canarydemo.yml` matches the `canary-workflow` default in
   `northstar-metrics.yml`.
6. Each of the four rules opens an issue on firing, comments on repeat firing, and
   closes on recovery; `alerts: false` suppresses all writes while still rendering.
7. `lib/alerts.test.js` covers firing / clear / skipped and both transitions for every
   rule.
8. `npm test` passes; the dashboard renders a canary line and an Alerts section.
9. `docs/observability.md` documents install, required consumer permissions, the
   `ANTHROPIC_API_KEY` secret, thresholds, and expected cost.
