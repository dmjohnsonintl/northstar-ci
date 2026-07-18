# Northstar (v0)

A reusable GitHub Actions package that enforces test-coverage discipline on a repo:
run the test suite, enforce a **coverage gate** (minimum + no-downward-trend), and
promote green staged tests into a permanent regression suite — all from a one-line
install.

> v0 is the thin slice: green-path coverage gate for JS/TS (Jest / Vitest /
> `node:test`). The AI fix-agent, bug-intake, and monitoring land in later versions.

## Install

Add `.github/workflows/ci.yml` to your repo:

```yaml
name: Northstar
on:
  pull_request:
  push:
    branches: [main, master]
jobs:
  northstar:
    uses: dmjohnsonintl/northstar-ci/.github/workflows/northstar-pipeline.yml@v0
    with:
      workdir: frontend                # where your project lives
      zones-json: '[{"zone":"frontend","glob":"frontend/**"}]'
      coverage-min: '0'                # start at 0 to enforce trend-only, then raise
      coverage-mode: 'no-decrease'
```

Your project needs `test:ci` and `test:coverage` npm scripts, the latter emitting
`coverage/coverage-summary.json` (Istanbul `json-summary`). See
[`docs/adoption-v0.md`](docs/adoption-v0.md).

## Security
See [`SECURITY.md`](SECURITY.md). Short version: this package stores **no secrets**,
runs on `pull_request` (never `pull_request_target`), passes untrusted values via
`env:` (never interpolated into shell), and requests least-privilege token scopes.

## License
© Clear Blue Data LLC. All rights reserved. Contact the owner for licensing terms.
