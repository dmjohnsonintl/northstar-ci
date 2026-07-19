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
