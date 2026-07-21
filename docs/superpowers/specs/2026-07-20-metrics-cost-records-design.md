# Design: per-run engine cost records → light up the dashboard Cost line

**Date:** 2026-07-20
**Status:** Approved (brainstorm) — awaiting spec review before writing the implementation plan
**Repo:** `dmjohnsonintl/northstar-ci` (canonical code repo)
**Spec area:** Roadmap item "per-run metrics-record stream" (spec §12 / §14 remaining v1/v1.1 work)

## Goal

Fill the last `—` on the observability dashboard: **cost (tokens per run/role)**. The
metrics read-model derives everything else from GitHub-visible traces (run history,
PRs, labels, git log, claim refs); token/cost is the one fact traces don't carry,
because the fix engine's usage isn't recorded anywhere durable. This slice captures
per-run engine usage into a durable record stream and renders a real Cost section.

## Scoping insight

As of the 2026-07-19 "dashboard signals lit up" work, coordination-health and
regression-growth already render from traces. The **only** remaining placeholder is
`lib/metrics.js:221` ("Cost (tokens per run/role) requires engine token
instrumentation — shown as `—`"). So "per-run metrics-record stream" reduces, in
practice, to: **capture per-run engine token/cost and render it.**

## Key facts grounding the design

- The `claude` CLI (v2.1.215, confirmed) supports `claude -p --output-format json`,
  which returns a result envelope containing `total_cost_usd`, `usage`
  (`input_tokens`, `output_tokens`, `cache_read_input_tokens`), `model`, and
  `num_turns` — alongside performing the same edits.
- `lib/metrics.js` is a PURE, deterministic read-model (time injected via `now`,
  never `Date.now()`); absent fields render `—`, never a fabricated zero. This slice
  preserves that discipline.
- Records are produced by the **fix / fix-system jobs**, which work on a *fix branch*
  and open a PR — they never push to `main`, and the PR may never merge. So the
  record store must be writable from those jobs, independent of the fix branch, and
  conflict-free across parallel runs.

## Storage decision: a dedicated `northstar-metrics` branch

Chosen over Actions artifacts. Rationale: the metrics reader is already pure-git
(`fetch-depth: 0`, reads coverage history from git), so a branch keeps the whole
system "read a trace out of git" with no new API surface; it honors the project ethos
(inspectable traces in the client's own repo, no ephemeral hidden state — artifacts
expire at 90 days); and the branch's one weakness (push races) is already solved by
the rebase-retry-and-fail-loud push proven live this session.

- Orphan branch `northstar-metrics`, holding ONLY metrics data (no code).
- **One file per run:** `records/<runId>-<job>.json`. One-file-per-run means no
  content conflicts ever — only a possible ref race, handled by rebase-retry.

---

## 1. The record (schema + engine contract)

Each engine invocation produces one record. The engine reports only what it alone
knows (its own usage); the action adds run context.

### Engine contract extension

Every `engine/<name>/fix.sh` writes a JSON blob to the path in `$NS_FIX_RECORD`:

```json
{
  "engine": "claude-code",
  "costUsd": 0.0123,
  "tokens": { "input": 1234, "output": 567, "cacheRead": 8901 },
  "model": "claude-...",
  "numTurns": 3
}
```

- **claude-code** (`engine/claude-code/fix.sh`): invoke `claude -p --output-format
  json --permission-mode acceptEdits "$PROMPT"` (keeping `--bare` if compatible),
  capture stdout, and parse the envelope with `jq` into the blob. The edit behavior is
  unchanged — only the output envelope is added and parsed. If parsing fails (e.g. a
  future CLI shape change), write the blob with null cost/tokens rather than failing
  the fix (cost is observability, never blocks a fix).
- **stub** (`engine/stub/fix.sh`): write the same shape with `costUsd: null`,
  `tokens: null`, `model: "stub"`, `numTurns: null`. Honest nulls — this lets the full
  write→branch→read→render path be proven in CI on the stub with **no API spend**.

### Action-added context

`actions/fix-agent` passes `NS_FIX_RECORD` to the engine, then merges the engine blob
with fields only the action knows, producing the final record:

- `runId` (`github.run_id`), `workflow` (`github.workflow`), `layer` (unit | system —
  the `layer` input from the runner-breadth slice), `zone`, `outcome`
  (`fixed` | `escalated`), `createdAt` (ISO, from `github.event`/run start — passed in,
  never computed in the read-model).

Final record = engine blob ∪ context. Written to `records/<runId>-<job>.json`.

## 2. Storage & write path

A new step in the fix / fix-system jobs, **after** the fix-agent's PR/escalate step,
persists the record:

- Operates in an **isolated temp checkout** of `northstar-metrics` (via
  `git worktree add` or a temp `git clone --branch northstar-metrics --single-branch`)
  so it never disturbs the fix branch's working tree.
- **Creates the orphan branch if absent** (first run ever): `git switch --orphan
  northstar-metrics`, seed a `README.md`, then add the record.
- Commits `records/<runId>-<job>.json` and pushes with the **rebase-retry-and-fail-
  loud** loop (same shape as `promote-regression`). A record push that can't land after
  retries fails loudly (observability of the observability) rather than silently
  dropping.
- Uses the existing `contents: write` permission — **no new consumer permission**.
- The step is best-effort-guarded so a metrics-write hiccup never fails an otherwise-
  successful fix: it runs `if: always()` after the fix, and a push failure surfaces as
  a job annotation but is scoped so it doesn't mask the fix outcome. (Exact guard
  resolved in the plan; principle: cost accounting must not gate fixes.)

## 3. Read-model + dashboard

- New PURE function `costFromRecords(records, { now, sinceDays })` in `lib/metrics.js`:
  filters records whose `createdAt` is in the window; returns
  `{ totalCostUsd, runsWithCost, runsTotal, costPerRun, tokens: {input, output,
  cacheRead}, byLayer: { unit: {...}, system: {...} } }`. Records with null cost count
  toward `runsTotal` but not cost — so the dashboard can honestly say "3 fix runs, 1
  with cost data, $0.04 total." Empty input → all nulls (renders `—`).
- `renderDashboard`: replace the line-221 "Not yet wired / requires instrumentation"
  note with a real **Cost** section when records exist (total, per-run, tokens,
  unit-vs-system split); fall back to `—` when there are no records. Never a fabricated
  zero.
- `renderDigest`: optionally append `$X.XX cost` when present (small, honest).
- The metrics workflow (`northstar-metrics.yml`) gains a "gather records" step:
  `git fetch origin northstar-metrics` (tolerate absent branch → empty), read
  `records/*.json` within the window into `records.json`, and pass it to `metrics-cli`
  via a new `--records` flag.

## 4. Proof (stub-based, no API spend)

- A demo caller drives a deterministic failure → fix job on the **stub** engine → a
  null-cost record lands on `northstar-metrics` → the metrics demo renders the Cost
  section ("N runs, 0 with cost data"). Proves engine-emit → branch-persist → fetch →
  aggregate → render, green in CI, free. Reuses the existing `fixdemo` fixture pattern.
- Real `costUsd` numbers are exercised later by the **§12.1 nightly canary** (real
  engine, budgeted) — not a per-push demo. Same paid-vs-free split as the E2E slice.
- Unit tests:
  - `costFromRecords`: windowing (in/out of window), null-cost handling (counted as a
    run but not cost), per-layer split, empty → nulls/`—`.
  - The claude-code JSON-parse helper: fed a captured sample `--output-format json`
    envelope (a fixture string), asserts it extracts cost/tokens/model — no CLI needed.

## 5. Scope boundaries (YAGNI)

- **Fix path only** (`fix` + `fix-system` jobs). The **reproduce/bug-intake** engine
  path (`reproduce.sh`) will emit cost via the same contract eventually — a named
  follow-up, not this slice.
- Record schema is **extensible** (future per-run facts like fix latency or retry
  counts can be added), but only cost + join keys are populated now.
- No change to the other dashboard signals — this fills the one remaining `—` only.
- The `northstar-metrics` branch is documented (a one-liner in the observability doc)
  so it isn't a surprise; it is never merged into `main`.

## Explicitly out of scope (named follow-ups)

- Cost from the **reproduce/bug-intake** engine path.
- Real-engine cost **proof** in CI (→ §12.1 nightly canary).
- Cost **budget alerts / thresholds** (belongs with §12.1 alerting).
- Per-run non-cost facts (latency, retries) — schema allows them; not populated now.
- **Record retention / pruning** on the `northstar-metrics` branch — records accumulate
  one-per-run and `costFromRecords` already windows by `createdAt`, so old records are
  dead weight; a window-prune or periodic squash (and a bounded gather) is a named
  follow-up that pairs with the §12.1 nightly-canary/alerting work. Until then the
  gather is guarded so a bad record can't black out the dashboard.

## Acceptance criteria

1. Both engines write a `$NS_FIX_RECORD` blob; claude-code parses real
   cost/tokens/model from `--output-format json`; stub writes honest nulls. Unit-tested
   via a captured JSON envelope (no CLI).
2. The fix / fix-system jobs persist `records/<runId>-<job>.json` to the
   `northstar-metrics` branch (created if absent) via a rebase-retry push, in an
   isolated checkout that doesn't disturb the fix branch; a metrics-write failure never
   fails an otherwise-successful fix.
3. `costFromRecords` is a pure, unit-tested read-model (windowing, null-cost, per-layer,
   empty→`—`).
4. `renderDashboard` shows a real Cost section when records exist and `—` when none;
   `metrics-cli` accepts `--records`; `northstar-metrics.yml` gathers them from the
   branch.
5. A stub-engine demo proves the full path green in CI: a null-cost record lands on the
   branch and the rendered dashboard's Cost section reflects it — with no API spend.
6. The existing dashboard behavior for all other signals is unchanged.
