# Northstar — state of play

**As of 2026-08-05.** Hand-written snapshot of where the project actually is:
release state, who has adopted it, what was recently fixed and why, and what is
open. Distinct from [`northstar-status.md`](northstar-status.md), which is
generated every metrics run and reports live numbers.

## What Northstar is

An installable, versioned GitHub Actions package that turns a repo into a
governed testing environment: run the suite, enforce a coverage gate (minimum +
no-downward-trend), promote green staged tests into a permanent regression suite,
and on a real test failure dispatch a bounded fix-agent that always lands in a
human-reviewed PR. Coordination is stigmergic — stages never call each other,
they leave traces (check statuses, labels, claims/signals with TTL) that other
stages notice. Consumers install it with one `uses:` line; their code never
leaves their own runners.

Full design: [`superpowers/specs/2026-07-18-northstar-design.md`](superpowers/specs/2026-07-18-northstar-design.md).

## Release state

| | |
|---|---|
| Canonical repo | `dmjohnsonintl/northstar-ci` (public) |
| Release tag | `v0` — moving; re-tag on code changes, not on dashboard commits |
| Tests | 102 total, 97 passing, 5 skipped (Python adapter, local toolchain only) |
| Predecessor | `dmjohnsonintl/Northstar` (private) — **archived**, superseded, its spec + v0 plan migrated here |

`main` routinely runs a commit or two ahead of `v0` because the metrics workflow
commits `northstar-status.md` on a schedule. That is expected. See
[`publishing.md`](publishing.md) for the re-tag procedure and the drift check.

## Adoption

| Repo | Zones | State |
|---|---|---|
| `alto-works` | frontend (js-ts) + backend (python) | **Live** since 2026-07-23. Baselines ratcheting (64.12% / 74.91%) |
| `council-principis` | frontend (vitest) + backend (pytest) | **Live** since 2026-08-05. Baselines established (20.12% / 74.64%) |
| `a11yplus` | api (Django) | PR #1 **open, unmerged** since 2026-07-23 — owner is handling it |

Both live consumers run `engine: 'stub'`. **The real fix-agent has never
completed a run against a client bug** — see Blocked below.

### Two consumer-shaped gotchas worth remembering

- **`alto-works` keeps two workflow files on purpose.** Its split also does
  `paths:` filtering (`frontend/**` vs `backend/**`), so collapsing it would run
  backend CI on frontend-only changes. Council Principis' split existed *only* to
  dodge the concurrency bug and was correctly collapsed to one caller.
- **Neither repo pins Node.** Council Principis' suite failed the first time it
  ever ran in CI (`ReferenceError: navigator is not defined` — Node exposes that
  global only from v21) purely because CI requested an older Node than any
  developer runs. Worked around with `node-version: '22'`; the durable fix is an
  `.nvmrc`/`engines` pin in each repo.

## Recently fixed — a chain of silent failures

The theme, and the thing to internalize: **every one of these was defensive code
converting a loud failure into a quiet wrong answer.** In a system whose job is
telling you when a human is needed, that is the most expensive possible bug class.

1. **Concurrency group collision** (issue #12, fixed `9986613`). `github.workflow`
   resolves to the *caller's* name inside a reusable workflow, so two zone jobs in
   one caller shared a concurrency group and `cancel-in-progress` killed one.
   A zone vanished with no failure to point at. Group now folds in `workdir`.
   Proven with a live A/B: same caller, cancelled before, both green after.

2. **`Human acceptance: 0%` was measuring nothing** (fixed `0c373e3`). Two
   independent bugs: `gh pr list --state closed` **includes merged PRs**, so every
   merge was double-counted into the denominator and the rate could never exceed
   50%; and the nightly canary opens an `ns/fix/<run_id>` PR that its own cleanup
   closes, so every canary run registered as a human rejection. Fixed by
   `metrics.fixPrOutcomes`, which identifies canary PRs from run ids already
   present in `runs.json` — no new label, gather, or permission.

3. **Escalations never reached a human** (fixed `8bf7ee4`). `gh issue create`
   needs `issues: write`; the adoption doc told consumers to grant only
   contents + pull-requests; `|| echo ::warning::` swallowed the denial and the
   job exited **0**. Rebuilt on `pull-requests: write`, which adoption already
   requires: escalation now comments on the PR, adds `ns:needs-human`, and the
   job **fails**. Metrics counts both channels.

   > **Do not "fix" this by declaring `issues: write` in the pipeline.** A
   > reusable workflow that declares a permission its caller did not grant does
   > not degrade — the entire run ends in `startup_failure` with no jobs, no logs
   > and no diagnostic. Verified directly (run `30977506426`). Doing that on the
   > moving `v0` tag would silently break every consumer that had not updated.

4. **The engine faked success** (fixed `a248881`, `b32fab7`). `claude -p …
   2>/dev/null || true` discarded stderr *and* the exit code, and "did it do
   anything?" was `git status --porcelain` + `git add -A` — so an untracked
   `artifacts/test.log` counted as a fix. A total engine failure was reported as
   *"claude-code engine committed a fix"*. Now: both streams surfaced on failure,
   detection is `git diff --name-only`, staging is `git add -u`.

## Live signals right now

- **Issue #27 open — `Northstar alert: human-acceptance` is firing:** *"Humans
  merged 0% of fix-agent PRs (0 merged / 6 decided)."* This is the new rule
  working correctly on real data, with canary PRs excluded from the sample. It is
  a true statement about a real gap, not a false alarm.
- Issue #4 (`ns:bug`) is the intentional `examples/bugdemo` fixture. Ignore.
- Nightly canary green; GC sweeping hourly.

## Blocked

**The first real fix-agent run.** `council-principis` PR #51 carries a
deliberately seeded bug (a dropped accumulator flush in
`frontend/src/speech/chunkForSpeech`, 2 genuine test failures) with
`engine: 'claude-code'` enabled on that branch only. Every run so far has
returned in ~2s having done nothing. The now-surfaced diagnostic:

```json
{ "api_error_status": 400, "result": "Credit balance is too low",
  "terminal_reason": "api_error", "total_cost_usd": 0 }
```

**The account behind the `ANTHROPIC_API_KEY` secret has no credit.** Nothing is
wrong with the wiring, the secret, or the agent. Add credit (or swap in a funded
key) and `gh run rerun 30976878181 --failed` — no other setup, ~$0.06.

## Open, roughly by value per effort

1. **Finish the fix-agent experiment** (above). It is the only genuinely unknown
   thing left; everything below is known work. It is also the first data that
   would ever move the human-acceptance number in #27.
2. **Implementation plan for the adoption-stalled rule.** Spec is written and
   corrected: [`superpowers/specs/2026-08-02-adoption-alerting-design.md`](superpowers/specs/2026-08-02-adoption-alerting-design.md).
3. **README.** Still says the fix-agent, bug-intake and monitoring "land in later
   versions." All three shipped. It is the front door and it undersells by a full
   version. It also omits the `permissions:` block that `adoption-v0.md` requires.
4. **`scan-core` and `a11yplus-worker`.** Both have real 15-file `node --test`
   suites; each needs `c8` plus `test:ci`/`test:coverage` scripts. Would take
   adoption from two repos to four.
5. **Pin Node** in the client repos (see above).
6. **Engine cannot detect a fix that creates a new file.** Deliberate tradeoff
   from #4 — `git add -u` stages tracked modifications only, so artifacts can
   never be swept in. That case now fails loudly rather than committing junk,
   which is the safe direction, but it is a real limitation.

## Known-good verification habits in this repo

Worth keeping, because each one caught something real:

- Prove a regression test **fails against the genuine pre-change file** from git,
  not against a hand-edited approximation — a botched revert once "passed" three
  tests for the wrong reason.
- `actionlint` validates *context availability*, not just YAML — a clean run is
  real evidence that `inputs` resolves inside `concurrency:`.
- Probe a platform assumption with a throwaway workflow before designing around
  it. The `startup_failure` probe changed the escalation design entirely.
- Run the real thing once. The Council Principis adoption surfaced a latent Node
  portability bug the first time that suite ever ran outside a laptop.
