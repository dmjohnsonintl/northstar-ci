# Observability (Tier 1 dashboard + daily digest)

Northstar's monitoring is **aggregation of traces the pipeline already emits** —
GitHub Actions run history, the coverage-baseline file's git history, Northstar
PRs, and `ns:*` labeled issues. No secrets, no hosted SaaS; the read-model lives
in your own repo (spec §12).

## What you get
- **`docs/northstar-status.md`** — an always-current dashboard: pipeline green
  rate (per workflow), coverage trend, and agent/model health (fix success rate,
  escalations, bugs reproduced). Also written to each run's **job summary**.
- **Daily digest** (opt-in) — a one-line summary posted to a deduped issue, e.g.
  *"Northstar (last 7d): 23 runs, 88% green, coverage 80%→83% (▲ +3), 4 auto-fixed,
  0 escalated, 2 promoted."*

## How it maps to the six signals (§12)
| Signal | Source | Status |
|---|---|---|
| Pipeline health | `gh run list` conclusions + durations | ✅ |
| Coverage trend | git history of `coverage-baseline.json` | ✅ |
| Agent effectiveness | Northstar PRs vs `ns:needs-human` issues | ✅ |
| Regression growth | promotions | ⏳ needs the per-run record stream |
| Cost (tokens / CI min) | per-run record stream | ⏳ shown as `—`, never a fake 0 |
| Coordination health | claim/flake signals | ⏳ substrate-backed mode |

Deferred signals render as `—` in the dashboard rather than a fabricated zero.

## Enable it
Add a scheduled caller (see `.github/workflows/metricsdemo.yml`):

```yaml
name: northstar-metrics
on:
  schedule: [{ cron: '17 13 * * *' }]
  workflow_dispatch:
jobs:
  metrics:
    uses: dmjohnsonintl/northstar-ci/.github/workflows/northstar-metrics.yml@v0
    with:
      since-days: 7
      baseline-path: .northstar/coverage-baseline.json
      commit-dashboard: true
      post-digest: true
    permissions:
      contents: write   # commit the dashboard
      issues: write     # post the digest
```

The logic is a pure, unit-tested read-model (`lib/metrics.js`); the workflow is a
thin shell that feeds it `gh run list --json`. Because the aggregation takes the
current time as an input (never `Date.now()`), the same traces always render the
same dashboard.

## Cost & the `northstar-metrics` branch

Fix runs emit a per-run usage record (token/cost) that GitHub run-traces don't
carry. Records live on a dedicated **`northstar-metrics`** orphan branch (one file
per run under `records/`), written by the fix-agent with a rebase-retry push — this
branch holds only metrics data and is **never merged into `main`**. The metrics
workflow reads it (`git archive`) and renders the dashboard's **Cost** section.

Runs on the `stub` engine emit honest **null-cost** records (the stub spends
nothing), so the pipeline is provable without API spend; real dollar/token figures
appear when a consumer sets `engine: claude-code`.

## Canary (real-engine drift detection)

Because the default pipeline runs on the deterministic `stub` engine, it can prove
its own logic but not that the real model/tool integration still works day to day.
The **canary** closes that gap: a nightly run of a small, deliberately-broken
fixture (`examples/aidemo`) through the real `claude-code` engine, asserting the
agent still fixes it end-to-end.

- **`northstar-canary.yml`** (reusable workflow) — runs the fixture through the
  full fix/assert/cleanup cycle and emits a normal `gh run` conclusion (green/red),
  so it shows up in the same run-history traces the metrics dashboard already reads.
- **`canarydemo.yml`** (scheduled caller) — the nightly trigger. Requires
  `contents: write` + `pull-requests: write` (to open/manage the fix PR and clean up
  its branch) and the `ANTHROPIC_API_KEY` secret (the only place in the pipeline
  that spends real tokens).
- **Expected cost**: ~$0.02–0.10 per run, i.e. roughly **$10–35/year** for a nightly
  schedule — small enough to run indefinitely as a drift tripwire.

Add it with:

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

The metrics dashboard folds the canary's latest conclusion into its Agent Health
section (🟢/🔴), and the canary's cost record flows into the same per-run usage
stream as ordinary fix runs.

## Alerting (§12.1)

The metrics workflow evaluates six alert rules on every run, using the same
traces it already gathers (no extra API calls beyond enumerating claim refs):

| Rule | Fires when | Default threshold | Severity |
|---|---|---|---|
| `escalation-rate` | escalations / opened fix PRs exceeds the rate | `0.5` | trend |
| `coverage-trend` | coverage delta from the previous point is negative | delta-min `0` | trend |
| `claim-starvation` | any active coordination claim is older than the threshold | `21600`s (6h) | trend |
| `human-acceptance` | humans merge less than this share of **decided** fix PRs | `0.5`, min sample `3` | trend |
| `adoption-stalled` | a tracked adoption is too old or too far behind | `259200`s (3d) / `25` commits | trend |
| `canary` | the latest canary run concluded red | — | page |

### `adoption-stalled` — operator-side, opt-in, off by default

The only rule that is **not** about the repo it runs in. It answers *"is my rollout
stuck?"*, a question about a portfolio, so `adoption-repos` defaults to empty: no
gather runs, the rule is omitted, and a client install is byte-for-byte unaffected.
Cross-repo reads need an optional `NS_ADOPTION_TOKEN`; without it the sweep reads
nothing and the rule is omitted rather than reporting a false clear.

It watches the **`ns/adopt-*` branch**, not the PR — adoption work always starts as a
branch and only sometimes becomes one. Two firing conditions, because the two real
incidents that motivated it degrade differently: one sat 12 days at **zero** commits
behind (age only), the other drifted 55 commits behind until it was unsafe to merge.


### `guard-trip` — the §7.3 diff-guard

Northstar's central promise is that the fix-agent makes tests pass by fixing
**source**, never by weakening tests. That was enforced only by a sentence in the
engine prompt until `lib/diff-guard.js` turned it into a gate.

It runs on the agent's own commit, **before** the suite is re-run — a weakened suite
goes green, so checking afterwards would reward exactly the behaviour being
prevented. It rejects three unambiguous cheats: deleting a test file, adding a
skip/todo marker (jest, vitest, mocha, node:test, pytest, unittest), and a net
removal of assertions. Removing a skip marker is *allowed* — that re-enables a test.

Assertion counting is by **occurrence, not line**. Counting lines missed the most
obvious cheat available: a one-line test with two assertions, one deleted — both the
old and new line "contain an assertion", so it netted zero. Found by running the
guard against real `git diff` output rather than only unit fixtures.

A rejection fails the fix job and emits `ns:signal/guard-trip` (TTL 7d), which is the
trace §12.1's guard-trip-rate health signal was always specified to read.

### `human-acceptance` — read the counting rules before tuning it

Spec §12.1 names this signal, and it is the only one that measures the *human*
half of the loop: is the agent producing PRs people actually take? Two counting
traps make a naive implementation report a number that is not merely imprecise but
structurally wrong, so the counts come from the pure, unit-tested
`metrics.fixPrOutcomes` rather than from the gather:

- **`gh pr list --state closed` includes MERGED PRs.** GitHub models a merge as a
  close. Counting that as "closed unmerged" puts every merge in the denominator
  twice, capping the rate at 50% even if everything merged.
- **The nightly canary opens an `ns/fix/<run_id>` PR that its own cleanup closes.**
  Those carry no labels, so nothing distinguishes them from a genuine fix PR by
  name. Each canary run would otherwise register as a human rejection. They are
  identified by matching the run id in the branch name against `runs.json`, which
  the workflow already gathers.

Also: **open PRs count toward neither outcome** — undecided is not rejected — and
below `acceptance-min-sample` decided PRs the rule is *omitted*, because a single
declined PR is a 0% rate and should not page anyone.

Each rule has three states — `firing`, `clear`, and *omitted* (no data, never a
fabricated clear) — evaluated the same way in the always-on unit tests
(`lib/alerts.test.js`) as in CI.

**Issue lifecycle** — one deduped issue per rule, matched by title against **open**
issues labeled `ns:alert`:
- `firing` + no open issue → **create**, labeled `ns:alert` + `ns:alert/page` or
  `ns:alert/trend`.
- `firing` + an open issue already exists → **comment** "Still firing".
- `clear` + an open issue exists → **comment** "Recovered", then **close** it.
- `clear` + no open issue → nothing (no-op).

Labels are created idempotently (`gh label create ... --force`) as a backstop
before the first issue is ever opened, so a missing label can't fail the run.

**Render-only opt-out** — set `alerts: false` on the caller to still evaluate the
rules and render the `§12.1 Alerts` section to the job summary, without writing,
commenting on, or closing any issue. Useful for dry-running new thresholds.

Tune the rules via the caller's `with:` block: `escalation-rate`,
`coverage-delta-min`, `claim-age-seconds`, `canary-workflow` (must match the
canary's workflow `name:` — default `'Northstar canary'`), and `alert-label`
(default `'ns:alert'`).
