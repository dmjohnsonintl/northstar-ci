# Northstar — state of play

**As of 2026-08-05 (paused, evening).** Hand-written snapshot of where the project actually is:
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
| Tests | 104 total, 99 passing, 5 skipped (Python adapter, local toolchain only) |
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
| `scan-core` | core (js-ts) | PR #1 **open** — c8 wired, 81.3% verified locally |
| `a11yplus-worker` | worker (js-ts) | PR #1 **open, blocked** — see below |

### In flight (2026-08-05 evening)

| PR | What | State |
|---|---|---|
| [alto-works #39](https://github.com/dmjohnsonintl/alto-works/pull/39) | Pin Node 20 (off EOL 18) | **Green** — CRA 5 survives the bump. Mergeable |
| [council-principis #53](https://github.com/dmjohnsonintl/council-principis/pull/53) | Pin Node 22 (matches CI) | **Green.** Mergeable |
| [scan-core #1](https://github.com/dmjohnsonintl/scan-core/pull/1) | Adopt Northstar | CI was still running at pause |
| [a11yplus-worker #1](https://github.com/dmjohnsonintl/a11yplus-worker/pull/1) | Adopt Northstar | **Blocked** on `npm ci` |

**`a11yplus-worker` — where it got to, and what's left.** The first run failed for a
real reason: `test/e2e-scan.test.mjs` drives a **live browser** through
scan-core → Playwright. It passes on any developer machine with browsers installed
and fails on a bare runner — the same class of bug as the Council Principis Node
issue, and again surfaced the first time that suite ran outside a laptop. Fixed
properly rather than papered over: the test moved to `test/e2e/`, `test:ci` scoped
to `test/*.test.mjs`, and Northstar's **system layer** (which installs browsers)
given `system-test-cmd: npm run test:e2e`. The unit gate then went **green at
79.73%**.

It is now stuck one layer down: `npm ci` fails with *"can only install with an
existing package-lock.json"* even though the lockfile is committed and valid
(v3). **Reproduced locally**, so it is a genuine condition in that repo rather
than a CI quirk — most likely its `file:vendor/scan-core-1.2.0.tgz` dependency
combined with an `overrides` pin on `playwright`. Probable fix is regenerating the
lockfile, which is a larger diff than it was sensible to make unsupervised.

Both live consumers run `engine: 'stub'` by default. **The real fix-agent has now
been proven once against a real client bug** — see below.

### Two consumer-shaped gotchas worth remembering

- **`alto-works` keeps two workflow files on purpose.** Its split also does
  `paths:` filtering (`frontend/**` vs `backend/**`), so collapsing it would run
  backend CI on frontend-only changes. Council Principis' split existed *only* to
  dodge the concurrency bug and was correctly collapsed to one caller.
- **Unpinned Node is the recurring bug class.** Council Principis' suite failed the
  first time it ever ran in CI (`ReferenceError: navigator is not defined` — Node
  exposes that global only from v21) purely because CI requested an older Node than
  any developer runs. `.nvmrc` + `engines` PRs are now open and green on both live
  consumers; merging them closes it. Every new adoption should pin Node **before**
  the first run, not after.

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
   detection is `git diff --name-only`, and staging is `git add -u` plus new files
   admitted by explicit path against a denylist (`0fbad01`) — `git add -A` is never
   used, so artifacts cannot ride along.

## Live signals right now

- **Issue #27 open — `Northstar alert: human-acceptance` is firing:** *"Humans
  merged 0% of fix-agent PRs (0 merged / 6 decided)."* This is the new rule
  working correctly on real data, with canary PRs excluded from the sample. It is
  a true statement about a real gap, not a false alarm.
- Issue #4 (`ns:bug`) is the intentional `examples/bugdemo` fixture. Ignore.
- Nightly canary green; GC sweeping hourly.

## The first real fix-agent run — done, 2026-08-05

The question this package existed to answer, and could not until today: **can the
real agent fix a bug that isn't a fixture with a known answer?** Yes.

A deliberately seeded bug on a `council-principis` branch — the accumulator flush
removed from `chunkForSpeech` in `frontend/src/speech/sentences.ts`, 2 genuine
failures out of 256 tests, `engine: 'claude-code'` on that branch only. It was
committed under a *misleading* message arguing the removed line was redundant,
which is the exact wrong reasoning that produces this defect. The agent had that
framing in context and rejected it:

```diff
       else { out.push(buf); buf = part; }
     }
+    if (buf) out.push(buf); // flush the last clause group — otherwise the tail is dropped
   }
```

| | |
|---|---|
| Result | 256 / 256 green |
| Turns | 10 |
| Cost | **$0.18** |
| Tests touched | none — source only |

Both experiment PRs (#51, #52) were **closed, not merged**: the fix branch
descends from the test branch, so merging would have dragged the
`engine: 'claude-code'` flip into `master`, and the fix is a no-op against
`master` anyway — the bug only ever existed on the branch.

### Three failures on the way, each one loud

Worth recording, because it is the instrumentation work paying for itself. The
same sequence two days earlier would have presented as "job passed, nothing
happened," three times:

1. `Credit balance is too low` — the key in `~/.zshrc` belonged to a different
   Anthropic account.
2. `Invalid API key` — the replacement was pasted with stray whitespace.
   `gh secret set --body` stores exactly what it is given; pipe through
   `tr -d '[:space:]'`.
3. `PR creation failed. Enable…` — see the open item below.

**One key for everything.** `ANTHROPIC_API_KEY` is the same value in every repo
(`northstar-ci`, `council-principis`, and any future consumer). There is no
per-client key, and a workspace per client only adds another spend cap to
misconfigure.

## Open, roughly by value per effort

1. **Enable PR creation on `council-principis`.** Settings → Actions → General →
   Workflow permissions → *"Allow GitHub Actions to create and approve pull
   requests."* Without it the fix-agent pushes its branch but cannot open the PR —
   #52 had to be opened by hand. This is step 5 of [`adoption-v0.md`](adoption-v0.md)
   and the last consumer-side gap. `alto-works` needs checking too.
2. **Decide whether `engine: 'claude-code'` goes on by default** anywhere, now
   that it is proven. It is per-caller config, so it can be enabled one zone at a
   time. Budget roughly $0.18 per real failure.
3. **Implementation plan for the adoption-stalled rule.** Spec is written and
   corrected: [`superpowers/specs/2026-08-02-adoption-alerting-design.md`](superpowers/specs/2026-08-02-adoption-alerting-design.md).
4. **README.** Still says the fix-agent, bug-intake and monitoring "land in later
   versions." All three shipped. It is the front door and it undersells by a full
   version. It also omits the `permissions:` block that `adoption-v0.md` requires.
5. **`scan-core` and `a11yplus-worker`.** **PRs open** — scan-core is wired and
   verified; a11yplus-worker is blocked on `npm ci` (see In flight above). Finishing
   these takes adoption from two repos to four.
6. **Pin Node** in the client repos. **Both PRs open and green** — merge when ready.
~~7. **Engine cannot detect a fix that creates a new file.**~~ **Done** (`0fbad01`).
   New files are admitted by explicit path against a denylist, so a fix that adds a
   module is committed while `artifacts/` and `coverage/` written in the same run
   are not. `git add -A` is still never used.

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
