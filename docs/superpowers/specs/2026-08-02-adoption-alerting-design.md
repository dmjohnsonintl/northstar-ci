# Design: adoption-stalled alert rule

**Date:** 2026-08-02
**Status:** Draft — awaiting review before writing the implementation plan
**Repo:** `dmjohnsonintl/northstar-ci` (canonical code repo)
**Spec area:** Extends §12 "Observability & monitoring" with a **seventh signal**
(adoption health). Adjacent to — but not part of — §12.1, which covers agent/model
health. This is deliberately a spec *extension*, not an implementation of existing text.

## Goal

Answer a question no existing Northstar signal answers: **is anyone actually
adopting this?**

Every current rule watches the machine half of the loop. The two steps that decide
whether Northstar survives as a product are the two where the participant who must
act is a **human** — merging an adoption, merging a fix PR — and neither is
instrumented. People don't run on a cron; the traces they leave go unswept.

## The incident this exists to prevent

Reconstructed from the record on 2026-08-02:

| When | What |
|---|---|
| Jul 23 01:33Z | `council-principis` branch `ns/adopt-northstar` — last commit |
| Jul 23 02:12Z | `a11yplus` PR #1 opened (`ns/adopt-northstar` → `master`) |
| Jul 23 02:17Z | Issue #12 filed (concurrency footgun hit during the rollout) |
| Jul 23 → Aug 2 | northstar-ci: **11 bot commits, 0 human commits** |
| Jul 28–29 | `council-principis` master takes **55 commits** in 48h |
| Aug 2 | Both adoptions discovered still unmerged |

**Ten days undetected.** Throughout, every existing alert rule was correctly `clear`
and the dashboard read 98% green, canary 🟢, fix success 100%. Nothing was broken.
Nothing was watching.

Two distinct failure modes, both real:

- **Mode A — stalled.** `a11yplus` PR #1: `mergeable: true`, 1 file, 31 lines, zero
  comments, never updated after creation. Its `master` has had **zero commits since
  Jul 23**, so it is not stale — it was simply never clicked. Nothing about drift
  would ever have fired on it.
- **Mode B — stalled *and* drifted.** `council-principis` PR #44 on branch
  `ns/adopt-northstar`: **4 ahead / 55 behind** `master`, and the 55 collide on all
  three files the adoption had to modify (`frontend/package.json`,
  `package-lock.json`, `vite.config.ts`), plus its committed coverage baseline now
  describes a frontend that has since grown by 23 files. Age alone understates it:
  this one was not merely forgotten, it had become unsafe to merge.

> **Correction (2026-08-04).** An earlier draft characterized Mode B as "branched,
> never proposed" and justified Decision 2 with it. That was wrong — PR #44 existed
> and had been open since 2026-07-23T01:17:05Z. Both real cases carried an open PR.
> Decision 2 stands, but on defensive rather than observed grounds; see there.

## Scoping insight

**The trace already exists and needs no new primitive.** Both real adoptions
independently used the branch name `ns/adopt-northstar` — the same `ns/` namespace as
`ns/fix/*`, `ns/bug/*`, and `ns/claim/*`. Adoption already leaves a stigmergic marker
in the environment; nothing sweeps it.

So this slice adds a **sweep**, not a mechanism, and it mirrors the existing claims
path exactly: the workflow gathers an array into a JSON file, a pure rule applies
policy to it, the issue lifecycle acts on the decision. No new storage, no new
coordination primitive, no second writer on the metrics branch.

## Key facts grounding the design

- `lib/alerts.js` rules are **pure**, take injected `now`, and are **omitted** when
  their input is missing. Three states, never two. This rule must obey that.
- `model.claims` sets the precedent for a rule consuming a workflow-gathered array
  (`claims.json`), so `model.adoptions` needs no new architecture.
- Projection and policy are separated: `lib/metrics.js` decides what a payload
  *means*, `lib/alerts.js` decides what counts as *bad*. Thresholds do not leak into
  metrics.
- `northstar-metrics.yml` already holds `contents: write` + `issues: write` and
  already runs guarded `gh` gathers where a transient failure must not abort the loop
  (the `|| true` fix in `ffa0ff6`).
- `GITHUB_TOKEN` is **scoped to the repo the workflow runs in**. Nothing about
  today's install can read another repo.
- §12's six signals are pipeline health, coverage trend, agent effectiveness, cost,
  coordination health, regression growth. **Adoption is not among them.**
- §12.1 already names *"Human-acceptance rate — agent PRs merged vs. closed-unmerged"*
  as a health signal, and the dashboard already renders it (`Human acceptance: 0%`) —
  but no rule alerts on it. Same blind spot, different trace. See out-of-scope.

---

## Decision 1: this is an operator-side signal, and that is a real tension

§12 states plainly that *"metrics live in the client's repo (portable, self-hosted,
consistent with the no-hosted-SaaS stance)."* Every existing rule honors that: a
client's install watches a client's own traces.

**This rule cannot.** "Is my rollout stalled?" is a question about a *portfolio of
repos*, asked by whoever is doing the rolling out. A client's install has no reason to
care, and no way to see the other repos.

Resolution — accept the asymmetry, contain it, and never let it leak into the client
path:

1. The rule is **opt-in via an explicit repo list** (`adoption-repos`, default `''`).
2. Empty list → no gather runs → `model.adoptions` absent → **rule omitted**. A
   default client install is byte-for-byte unaffected and never learns this exists.
3. It reads **only repos named in the input**. No discovery, no org-wide scan.
4. It stays self-hosted GitHub Actions in a repo you own, reading repos you own — so
   the no-hosted-SaaS stance holds. What changes is scope of *read*, not of *hosting*.

`SECURITY.md`'s "this package stores no secrets" also holds: the package stores none.
A cross-repo token, when used, is supplied by the operator's own install via
`secrets:`, exactly as `ANTHROPIC_API_KEY` already is.

## Decision 2: the trace is the branch, not the PR

**Both** real cases carried an open PR, so watching PRs alone would in fact have caught
both. This decision is therefore *defensive*, not evidence-driven, and it is worth
being honest about that rather than dressing it up.

The unit of observation is a **branch matching `ns/adopt-*`** on a named repo, because
the branch is the **superset**: adoption work always starts as a branch and only
sometimes becomes a PR. A rule keyed on PRs cannot see work that was pushed and then
abandoned before anyone opened one — a failure mode that is strictly more invisible
than the two observed, since it leaves nothing in any PR list to scroll past.

A PR, when one exists, is *enrichment* on the branch: it supplies a better age anchor
(`createdAt`) and a number to link. Absence of a PR is a reportable condition in its own
right, not a reason to skip.

The cost of this choice is that the gather must enumerate branches per repo rather than
issue one `gh pr list`, which is more API calls. Accepted: the sweep is scheduled, not
interactive.

## Decision 3: one rule, two firing conditions

The two modes degrade along different axes, and thresholding only one would miss the
other:

- **Age** catches Mode A. A11yPlus was 0 commits behind — nothing about drift would
  ever have fired.
- **Behind-count** catches Mode B's actual danger. A branch 2 days old and 55 behind is
  in worse shape than one 6 days old and 0 behind, because conflict risk and baseline
  staleness track divergence, not calendar time.

Fires when **either** crosses. One rule, because it is one question ("is this adoption
going to land?") with one issue and one lifecycle. The body names which condition
tripped, so the issue is actionable without opening the repo.

---

## 1. `lib/alerts.js` (edit): the fifth rule

```js
// 5. Adoption stalled (trend). Empty/absent → omit.
adoptionAgeSeconds   // default 259200  (3 days)
adoptionBehindMax    // default 25      (commits behind the default branch)
```

Reads `model.adoptions`. Omitted unless it is a **non-empty array** — matching
`claim-starvation` exactly. An operator who has not configured `adoption-repos` gets
no rule, not a `clear`.

| Field | Meaning |
|---|---|
| `repo` | `owner/name` |
| `branch` | the `ns/adopt-*` ref |
| `pr` | PR number, or `null` when never proposed |
| `prState` | `'open'` \| `null` |
| `since` | ISO — PR `createdAt` when a PR exists, else the branch tip commit date |
| `aheadBy` / `behindBy` | vs. the repo's default branch |

`since` deliberately falls back to the branch tip: for Mode B that is *the last moment
anyone touched the adoption*, which is exactly the age we want to measure.

**Firing** when any adoption satisfies
`(now - since) > adoptionAgeSeconds` **or** `behindBy > adoptionBehindMax`.

Body names each stalled adoption and its mode, e.g.

> `dmjohnsonintl/a11yplus` — PR #1 open 10d (threshold 3d), 0 commits behind.
> `dmjohnsonintl/council-principis` — branch `ns/adopt-northstar` **never proposed**,
> 10d since last commit, **55 commits behind** `master` (threshold 25).

**Clear** when adoptions were gathered and none trip either threshold — which is what
lets a merged adoption close its issue. Merging deletes the branch, so the adoption
leaves the array entirely; the array being non-empty-but-all-healthy and the array
becoming empty are different, and only the former can clear. See Error handling §3.

Severity: **`trend`**. `page` stays reserved for "the model stopped working."

## 2. `northstar-metrics.yml` (edit): gather, guarded

New step, skipped entirely when `adoption-repos` is empty. For each named repo:
enumerate branches matching `ns/adopt-*`, resolve the default branch, `compare` for
ahead/behind, and look for an open PR with that head. Writes `adoptions.json`.

Every `gh` call is individually guarded (`|| true`, skip on empty) per `ffa0ff6` — an
unreadable repo drops that repo from the array, never aborts the sweep. A repo the
token cannot see is indistinguishable from a repo with no adoption branch, which is
correct: absence of evidence is not evidence.

### New inputs

| Input | Default | Meaning |
|---|---|---|
| `adoption-repos` | `''` | Space-separated `owner/name` list. Empty → rule omitted |
| `adoption-age-seconds` | `259200` | 3 days — would have caught the incident on Jul 26 |
| `adoption-behind-max` | `25` | Council Principis was 55 |
| `adoption-branch-prefix` | `ns/adopt-` | The trace convention both real adoptions used |

### Token

Cross-repo reads need a token beyond `GITHUB_TOKEN`. Passed as an optional secret
(`NS_ADOPTION_TOKEN`); when absent, the gather is skipped and the rule is omitted —
degrading to today's behavior rather than to a false `clear`. Least privilege: read
contents + read pull-requests on the named repos only.

## 3. `lib/metrics.js` (edit): dashboard section only

An `## Adoption` section, rendered whenever adoptions were gathered:

```
## Adoption

| Repo | Branch | State | Age | Behind |
|---|---|---|---|--:|
| dmjohnsonintl/a11yplus | ns/adopt-northstar | PR #1 open | 10d | 0 |
| dmjohnsonintl/council-principis | ns/adopt-northstar | no PR | 10d | 55 |
```

Rendered even when the rule is `clear`, so the operator can see healthy adoptions —
the dashboard is the always-current surface, the alert is the push. Absent data
renders `—`, never a fabricated `0`.

## 4. Error handling

1. **Missing data never fabricates a verdict.** No list, no token, no reachable repo →
   omitted, not `clear`. This is the single most important property: the incident was
   *silence read as health*, and a rule that reports `clear` when it cannot see is a
   worse version of the same bug.
2. **A failed adoption write never blacks out the dashboard.** Issue actions run after
   the dashboard commit and are individually non-fatal, per existing practice.
3. **A merged adoption must close its issue, not orphan it.** Merging deletes the
   branch, so the adoption vanishes from the array — and an empty array is *omission*,
   which cannot close anything. The gather therefore emits a **sentinel** for a
   configured repo with zero adoption branches (`{repo, branch: null}`), so "configured
   and healthy" is representable and distinguishable from "not configured." This is the
   one place the rule's shape is not a copy of `claim-starvation`, and it is
   deliberate: claims are ephemeral by design, adoptions are supposed to disappear by
   *succeeding*.

## 5. Testing

`lib/alerts.test.js` gains, per the existing per-rule standard — firing / clear /
omitted, plus both transitions:

- fires on **age** alone (Mode A: A11yPlus shape — 10d old, 0 behind)
- fires on **behind** alone (Mode B: Council Principis shape — 1d old, 55 behind)
- fires with **no PR** (`pr: null`) — the case a PR-watching rule would miss
- `clear` when all gathered adoptions are inside both thresholds
- `clear` when a configured repo has zero adoption branches (sentinel) — the
  merged-and-recovered path
- **omitted** on absent array, on empty array, and on `undefined`
- transitions firing→clear and clear→firing, since the issue lifecycle depends on them
- boundary: exactly `== adoptionAgeSeconds` does **not** fire (strict `>`, matching
  `coverage-trend`'s documented strict-`<` boundary choice)

The branch-coverage discipline is not optional here for the reason recorded in the
canary spec: the `run-suite` bug (`9c47b0b`) survived two days because a branchy path
was proven by one live demo that happened to take one branch.

## 6. Proof

The two real cases are the fixtures, which is unusually strong — this can be replayed
against recorded history rather than a synthetic scenario:

1. Gather against `dmjohnsonintl/a11yplus` and `dmjohnsonintl/council-principis` with
   `now = 2026-08-02`. Expect **firing**, both listed, correct modes and counts
   (0 behind / 55 behind).
2. Re-run with `now = 2026-07-25` (2 days after the branches were cut). Expect
   **clear** — proving the rule would not have cried wolf on day one.
3. Re-run with `now = 2026-07-26`. Expect **firing** on age — the claim that a 3-day
   threshold would have caught this on Jul 26, verified rather than asserted.
4. `adoption-repos: ''` → no gather, no rule, dashboard unchanged. A client install is
   provably unaffected.
5. Merge one adoption → next metrics run comments recovery and **closes** the issue.

## 7. Scope boundaries (YAGNI)

**In scope:** the fifth rule, the guarded gather, the four inputs, the optional token,
the dashboard section, tests, docs.

**Explicitly out of scope (named follow-ups):**

- **`human-acceptance` rule.** §12.1 already names it and `agentHealth` already
  computes it — today it renders `0%` (20 fix PRs opened, 0 merged) and alerts on
  nothing. It is the *same blind spot on a trace that already exists*, so it is the
  natural next slice and needs no gather at all. Kept separate to keep this one
  falsifiable.
- **Auto-rebase / auto-reminder.** Detecting is this slice; acting on the operator's
  behalf is a different risk profile.
- **Org-wide adoption discovery.** Explicit list only. Discovery invites scanning
  repos the operator did not intend to touch.
- **Adoption *quality*** (is the installed config sane, is the pinned tag current).
  A consumer pinned to a stale `v0` is a real signal and a different rule.
- **Client-side adoption health.** This rule is operator-side by construction
  (Decision 1); a client-facing variant is a separate design.

## Acceptance criteria

1. `adoption-repos: ''` (the default) produces **no gather, no rule, no dashboard
   change** — a client install is byte-for-byte unaffected.
2. The rule is **omitted**, never `clear`, when the list is empty, the token is
   missing, or no repo could be read.
3. Firing on age alone, on behind-count alone, and with `pr: null` are each covered by
   a test that fails if that condition is removed.
4. A configured repo with zero adoption branches yields `clear`, so a merged adoption
   closes its issue rather than orphaning it.
5. Replay against the two real adoptions at `now = 2026-08-02` fires with correct
   modes; at `now = 2026-07-25` it is clear; at `now = 2026-07-26` it fires.
6. A `gh` failure on one repo drops that repo and does not abort the sweep or the
   dashboard commit.
7. Issue lifecycle matches the existing four rules: open on fire, comment on repeat,
   comment + close on recovery, nothing when clear-and-never-fired.
8. `npm test` passes; `actionlint` clean; `docs/observability.md` documents the inputs,
   the token and its least-privilege scope, and the operator-side rationale.
