# Northstar

A reusable GitHub Actions package that puts a repo under **testing discipline**:
run the suite, enforce a coverage gate (minimum **and** no-downward-trend), promote
green staged tests into a permanent regression suite, and — when a real test failure
appears — dispatch a bounded AI fix-agent that always lands in a human-reviewed PR.

Install is one `uses:` line. Your code never leaves your own runners; the package
stores no secrets of its own.

## Install

Add `.github/workflows/northstar.yml`:

```yaml
name: Northstar
on:
  pull_request:
  push:
    branches: [main, master]

# REQUIRED. A called reusable workflow cannot exceed the caller's grant, and
# Northstar ratchets the coverage baseline and opens fix PRs on the default branch.
permissions:
  contents: write
  pull-requests: write

jobs:
  frontend:
    uses: dmjohnsonintl/northstar-ci/.github/workflows/northstar-pipeline.yml@v0
    with:
      workdir: frontend
      zones-json: '[{"zone":"frontend","glob":"frontend/**"}]'
      coverage-min: '0'            # start trend-only, raise once the baseline settles
      coverage-mode: 'no-decrease'
    secrets: inherit
```

Your project needs `test:ci` and `test:coverage` scripts, the latter emitting
`coverage/coverage-summary.json` (Istanbul `json-summary`). Python projects use
`adapter: python` and a `coverage json` command instead.

**Full setup — including the repo setting the fix-agent needs to open PRs — is in
[`docs/adoption-v0.md`](docs/adoption-v0.md).** Read it before your first run.

## What's in the box

| | |
|---|---|
| **Coverage gate** | minimum + no-downward-trend, ratcheted from a committed baseline |
| **Regression promotion** | green staged tests move into a permanent suite; one-way |
| **AI fix-agent** | single bounded attempt on a real test failure → PR. `stub` (free, default) or `claude-code` |
| **Bug intake** | an `ns:bug` issue is reproduced as a failing test before anything is fixed |
| **Adapters** | js-ts (Jest / Vitest / `node:test`) and Python (pytest); Playwright for an opt-in system-test layer |
| **Secret scan** | gitleaks hard-block — a leak stops the run before any agent is invoked |
| **Coordination substrate** | zone claims and advisory signals with TTL + scheduled GC |
| **Observability** | status dashboard, daily digest, per-run cost records, and five alert rules that open and close issues |

Multi-zone repos put one job per zone in a **single** caller workflow — concurrency
isolation is automatic. See [`docs/adoption-v0.md`](docs/adoption-v0.md#gating-more-than-one-zone).

## Enabling the real fix-agent

`engine: 'stub'` is the default and needs no API key. To use the real agent:

```yaml
      engine: 'claude-code'
```

and add an `ANTHROPIC_API_KEY` secret to the consuming repo. The same key value works
across every repo — there is no per-client key. Budget roughly **$0.18** per real
failure it attempts.

The agent is bounded by design: one attempt, source files only, and it is explicitly
forbidden from weakening, skipping or deleting tests. If it cannot make the suite
green it escalates to a human and **fails the job** — a human-needed state is never
a green check.

## Docs

| | |
|---|---|
| [`adoption-v0.md`](docs/adoption-v0.md) | Install, permissions, multi-zone, how escalation reaches you |
| [`observability.md`](docs/observability.md) | Dashboard, digest, cost records, the alert rules |
| [`coordination.md`](docs/coordination.md) | Claims, signals, zones, TTL and GC |
| [`system-tests.md`](docs/system-tests.md) | The opt-in Playwright layer |
| [`publishing.md`](docs/publishing.md) | Releasing the package itself |
| [`state-of-play.md`](docs/state-of-play.md) | Current status: adoption, what's fixed, what's open |
| [`northstar-status.md`](docs/northstar-status.md) | Live dashboard, regenerated on a schedule |

Design spec: [`docs/superpowers/specs/2026-07-18-northstar-design.md`](docs/superpowers/specs/2026-07-18-northstar-design.md).

## Security

See [`SECURITY.md`](SECURITY.md). Short version: this package stores **no secrets**,
runs on `pull_request` (never `pull_request_target`), passes untrusted values via
`env:` (never interpolated into shell), and requests least-privilege token scopes.

## License

© Clear Blue Data LLC. All rights reserved. Contact the owner for licensing terms.
