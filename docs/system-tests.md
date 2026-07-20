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
