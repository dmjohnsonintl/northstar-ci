# Northstar — Design Spec

**Date:** 2026-07-18
**Status:** Draft for review
**Owner:** David Johnson (clearbluedatallc)
**Repo:** `dmjohnsonintl/northstar-ci` (canonical code repo)

> **Provenance.** This is the foundational spec. It was written in the original
> private `dmjohnsonintl/Northstar` repo before the package was republished
> publicly as `dmjohnsonintl/northstar-ci`, and was migrated here unchanged so
> the section references in the later design docs resolve (e.g. the canary work
> cites **§12.1 Agent / model health**). Read any `dmjohnsonintl/Northstar` path
> below as `dmjohnsonintl/northstar-ci` — the private repo is archived.

---

## 1. Summary

Northstar is a **productized consulting offering**: an installable, versioned
**reusable GitHub Actions package** that turns any GitHub repository into an
optimized environment for **stigmergic, agent-driven development**. It is sold to
clients and dogfooded internally.

The core loop: unit tests are generated, stored, and run; coverage is enforced;
integration and system tests run; passing unit tests are **promoted into a
permanent regression suite**; and when anything fails, the **right specialized
agent (by code area × test layer)** is dispatched to correct it — bounded, and
always through a human-reviewed pull request.

"Stigmergic" is literal: pipeline stages never call each other directly. They
coordinate only through **traces left in the repository environment** — check
statuses, labeled issues, coverage artifacts, files in staging directories.
GitHub Actions is the coordination substrate. This design formally aligns that
coordination model to the published **Agent Coordination Substrate** spec
(`instagrim-dev/agent-coordination-substrate`): advisory **signals**, enforcement
**claims**, **induction** (convergence → artifact), **zone** addressing, **actor
identity**, and **mortality** (TTL + GC).

### 1.1 Market position (why this, why now)

The market is active ($1.2B in 2022 → ~$4.8B by 2030). Competitors ship
**fragments**: Diffblue (Java regression-test gen), Qodo (multi-agent SaaS test
gen + review), Mabl/Functionize/TestSprite (self-healing E2E SaaS), Gitar / Codex
autofix / Harness AI Agents (CI failure → PR), and GitHub Agentic Workflows (agents
in Actions from Markdown outcomes). "Generate tests" and "auto-fix a failing test"
are becoming **commodity primitives**.

Northstar's defensible position is the combination none of them ships:

1. **The full governed loop as one installable package** — gen → hard
   coverage-gate + no-downward-trend → **promotion into an immutable regression
   suite (with anti-test-weakening guards)** → **zone × layer routing to
   specialized fixers**.
2. **Stigmergic / substrate-conformant coordination** — signals, mortal claims,
   zones, TTL-GC. Unclaimed in the productized space; aligns Northstar with the
   substrate the reference team is already authoring.
3. **Portability / data residency** — a self-hosted reusable Actions package;
   **client code never leaves their runners** (vs. SaaS tools you upload code to).
4. **Consulting + dogfooded case studies** (ALTO Works, A11yPlus, Council Principis).

A Feb 2026 study found *test-writing volume has no statistically significant
effect on task resolution rates* — reinforcing that the value is **discipline and
coordination**, not test volume. The pitch leads with governance; "generate /
auto-fix" is treated as table-stakes plumbing.

---

## 2. Scope

**In scope (v1):**
- Reusable Actions package (composite actions + a batteries-included
  `workflow_call` workflow), config-driven via `northstar.config.yml`.
- **js-ts adapter**, runner-parametric: **Jest, Vitest, and `node:test`**, plus
  **Playwright** for system/E2E.
- Substrate-aligned coordination implemented natively on GitHub primitives.
- Full-product stages folded from the reference repos: secret-scan (gitleaks),
  auto-assign-reviewer, optional OIDC ECR deploy.

**Immediate fast-follow (v1.1):**
- **Python adapter** (pytest / Django / Lambda). Required by all three dogfood
  repos; not "later."

**Explicitly deferred:**
- Substrate-backed mode (HTTP service) — designed-in seam now, built later.
- Non-CI-testable edge targets (e.g. Council Principis `pi-client` hardware voice
  device) — represented as a non-gated zone, no adapter.
- Eval harnesses (distinct from tests) — out of scope.

**Non-goals:**
- Not a hosted SaaS. Not a managed service. Not a general agent cockpit (that is
  the horizontal layer Workstream Factory occupies; Northstar is the vertical
  testing engine that can plug into it).

---

## 3. Packaging & repository layout (Approach C)

Approach C = granular composite actions (the à-la-carte layer) **plus** a
batteries-included reusable workflow that wires them into the golden path.
Adoption is one `uses:` line + a config file; power users can compose the actions
directly. Behavior flexes per client through config, with **zero code forks**.

```
Northstar/                          # the package (what you sell / publish)
├─ .github/workflows/
│  ├─ northstar-pipeline.yml        # batteries-included reusable workflow (workflow_call)
│  └─ northstar-gc.yml              # scheduled mortality sweep (signals/claims TTL)
├─ actions/                         # granular composite actions (à-la-carte layer)
│  ├─ detect-changes/               # changed files → (zone, layer) via config + CODEOWNERS
│  ├─ run-suite/                    # run a layer via adapter; emit results + coverage
│  ├─ coverage-gate/               # enforce min% + no-downward-trend vs base branch
│  ├─ author-tests/                # Claude: write tests for gaps/new code → tests/new/
│  ├─ route-failure/               # failing check → select fixer role; acquire claim
│  ├─ fix-agent/                   # Claude: bounded-retry fix in isolated branch → PR
│  └─ promote-regression/         # green staged tests → tests/regression/, commit
├─ engine/                          # the reasoning-engine seam (see §8)
│  ├─ claude-code/                  # v1 engine: Claude Code Action harness
│  └─ gh-aw/                        # evaluation stub: GitHub Agentic Workflows engine
├─ lib/                             # extracted pure logic (unit-tested; see §7.1)
├─ adapters/
│  └─ js-ts/                        # Jest | Vitest | node:test + Playwright, coverage parse
│                                   #   (Python adapter added in v1.1: adapters/python/)
├─ schema/
│  └─ northstar.config.schema.json  # validated config contract
├─ examples/
│  └─ consumer-repo/                # deliberately broken fixture repo for our tests
├─ docs/                            # adoption guide, config reference, selling one-pager
└─ tests/                           # OUR tests for actions/adapters/lib (dogfooding)
```

**Consuming repo (client side):**
```
their-repo/
├─ .github/workflows/ci.yml         # uses: Northstar/.github/workflows/northstar-pipeline.yml@v1
├─ northstar.config.yml             # zones/routing, thresholds, retries, adapter, stages
├─ tests/new/                       # staging: freshly generated tests land here
└─ tests/regression/                # blessed suite: always run on every build
```

**Two load-bearing boundaries:**
- **Adapter boundary** — all language-specific logic lives in `adapters/*`. Actions
  call the adapter through a fixed four-command interface (§5). New language =
  new adapter, no action changes.
- **Config boundary** — all client-tunable behavior lives in `northstar.config.yml`,
  validated against the JSON schema before any agent spend.

---

## 4. Coordination model (substrate-aligned, GitHub-native)

Northstar adopts the substrate's **vocabulary and semantics** without taking a
runtime dependency on its HTTP service. Everything is implemented on GitHub
primitives.

| Substrate concept | Northstar implementation | Mortal? |
|---|---|---|
| **Zone** | path glob (`frontend/**`, `api/**`) from config + CODEOWNERS | — |
| **Advisory signal** | label: `ns:signal/coverage-gap`, `ns:signal/hot-area`, `ns:signal/flaky` + coverage artifact | TTL |
| **Enforcement claim** | `ns:claim/zone/<area>` lock-label + claim branch `ns/claim/<area>` | TTL |
| **Induction** | convergence → artifact: green-in-staging → promote; gap-signal → author | — |
| **Actor identity** | every label/commit/PR carries `ns:actor/<role>@<run-id>` | — |
| **Mortality / GC** | scheduled `northstar-gc.yml` expires stale signals/claims past TTL | — |

Substrate **conformance** is validated in CI: the claim/signal JSON matches the
substrate's published JSON Schemas (Draft 2020-12) and satisfies the six mandatory
properties (mortality, actor identity, zone addressing, inspectability, override,
readout). This is what makes "substrate-conformant" a credible marketing claim and
future-proofs substrate-backed mode.

**Zone resolution:** path-like, glob-matched with substrate semantics — exact,
single `*` (one segment), recursive `**`. Overlapping zones resolve
**most-specific-wins**, so each file has exactly one owning claim.

---

## 5. Components

### 5.1 Adapter interface (the language seam)

Every action shells out to the adapter through **four fixed commands** returning
JSON on stdout. Actions contain no language-specific logic.

| Command | Returns |
|---|---|
| `detect <changed-files>` | `{ areas:[], impactedTests:[] }` |
| `run <layer> [--runner jest|vitest|node|pytest]` | `{ passed, failures:[{test,file,message,area}], durationMs }` |
| `coverage <layer>` | `{ totalPct, byFile:{path:pct}, uncovered:[path] }` |
| `author <area> <layer> <targetDir>` | writes test files; `{ created:[paths] }` |

`adapters/js-ts` implements these over Jest / Vitest / `node:test` + Playwright,
reusing the reference repos' `set -o pipefail | tee` logging and `artifacts/<area>/`
outputs. `adapters/python` (v1.1) implements the same interface over
pytest/coverage.py/Django — **zero action changes**.

### 5.2 Composite actions

| Action | Consumes (trace in) | Produces (trace out) |
|---|---|---|
| **detect-changes** | PR diff, config, CODEOWNERS | `(zone, layer)` matrix as job outputs; `ns:signal/hot-area` |
| **run-suite** | a layer + adapter | check status + `artifacts/<zone>/` logs |
| **coverage-gate** | coverage JSON, base-branch coverage | pass/fail check; on gap → `ns:signal/coverage-gap` |
| **author-tests** | coverage-gap signal or new-code signal | test files in `tests/new/` (engine) |
| **route-failure** | failing check | `ns:claim/zone/<area>` acquire + fixer role selected |
| **fix-agent** | claimed failure | bounded-retry fix branch → PR (engine); exhaustion → `ns:needs-human`; release claim |
| **reproduce-bug** | `ns:bug` labeled issue (report + optional steps/logs/stack) | a **failing** test in `tests/new/` that reproduces the bug (engine); or `ns:needs-info` if it can't; or `ns:signal/stale-bug` if the bug is already gone |
| **promote-regression** | green `tests/new/` on main | move to `tests/regression/`, commit |

### 5.3 Full-product stages (from reference repos; config-toggleable)

- **secret-scan** — gitleaks, runs early on PR/push (upgraded from the references'
  dispatch-only trigger); a leak is a **hard block** and **no agent is invoked**.
- **assign-reviewer** — request a reviewer from a configurable pool on agent PRs
  and human PRs (reuses the references' `github-script` approach).
- **deploy hook** — optional final stage: OIDC-based ECR build/push (the safer
  `id-token` pattern), gated on full suite + regression green.

### 5.4 Config contract (`northstar.config.yml`)

```yaml
adapter: js-ts                      # js-ts (v1) | python (v1.1)
coverage:
  min: 80
  trend: no-decrease                # no-decrease | ratchet | report
zones:                              # zone × layer → fixer role/prompt
  - zone: frontend/**   -> prompt: prompts/frontend-fixer.md
  - zone: api/**        -> prompt: prompts/api-fixer.md
fix:
  maxRetries: 2
  maxTokens: 200000                 # per-attempt token ceiling (example default)
  maxConcurrentClaims: 3            # global cap on active fix-agents (example default)
  onSuccess: pull-request           # pull-request (default) | auto-commit
  onExhaustion: label-human
promote:
  stabilityRuns: 2                  # consecutive green main runs before promotion
coverageGen:
  maxNewTestsPerRun: 10             # example default
claim:
  ttlSeconds: 3600
  starvationThresholdSeconds: 21600 # 6h (example default)
engine: claude-code                 # claude-code (v1) | gh-aw (evaluation)
models:                             # per-role model tier (cost lever, see §11)
  route: claude-haiku-4-5
  author: claude-sonnet-5
  fix: claude-opus-4-8
bugIntake:                         # see §6 Trigger D
  enabled: true
  label: ns:bug                    # issue label that opens the intake door
  prompt: prompts/reproduce.md     # reproduce-first prompt for the intake agent
reviewers: [ ... ]                  # optional
stages: { secretScan: true, assignReviewer: true, deploy: false }
monitoring:                        # see §12
  dashboard: true                  # roll up traces to a repo dashboard
  exporter: none                   # none | otel | cloudwatch | datadog
  alerts: { escalationRate: 0.3, coverageTrend: negative, claimStarvation: true }
```

---

## 6. Data flow

**Trigger A — PR-time (pre-merge gate)** (`on: pull_request`):
```
detect-changes  → zones = {frontend, api}   (deposit ns:signal/hot-area, TTL 24h)
  → secret-scan (gitleaks) --fail--> BLOCK (no agent)
  → for each zone × layer:
      run-suite → check status + artifacts/<zone>/
      coverage-gate --below min / downward--> ns:signal/coverage-gap(zone)
          ├─ gap signal   → author-tests → tests/new/ → re-run
          └─ test failure → route-failure → acquire ns:claim/zone/<area> (TTL 1h)
                              (zone already claimed → queue; no collision)
                              → fix-agent (engine, ≤maxRetries)
                                  ├─ green     → PR + assign-reviewer → release claim
                                  └─ exhausted → ns:needs-human → release claim
```

**Trigger B — merge-to-main (promotion + deploy)** (`on: push: main`):
```
run full suite + tests/regression/  → all green?
  ├─ yes → promote-regression (induction): green tests/new/ → tests/regression/, commit
  │        └─ optional deploy hook (OIDC ECR build/push)
  └─ no  → route-failure → fix-agent (same loop)
```

**Trigger C — scheduled GC** (`on: schedule`): `northstar-gc.yml` sweeps expired
`ns:signal/*` and `ns:claim/*` labels so a crashed agent never permanently locks a
zone. (Mortality property satisfied.)

**Trigger D — bug intake (reproduce-first)** (`on: issues` labeled `ns:bug`):
```
ns:bug issue (report + optional steps/logs/stack)
  → detect-changes maps the report to a zone
  → reproduce-bug (engine): write a test that FAILS because of the bug
        ├─ reproduces        → failing test committed to tests/new/  ─┐
        ├─ can't reproduce   → ns:needs-info (ask reporter for steps/logs), stop
        └─ already fixed     → ns:signal/stale-bug (comment + close), stop
  ┌──────────────────────────────────────────────────────────────────┘
  ▼
  route-failure → acquire ns:claim/zone/<area> → fix-agent (engine, ≤maxRetries)
        ├─ green     → PR (fix + reproducing test) + assign-reviewer → release claim
        └─ exhausted → ns:needs-human → release claim
  ▼ (on merge to main, via Trigger B)
  promote-regression: the reproducing test → tests/regression/  (bug can never
  silently return)
```
The key discipline: **reproduction precedes any fix**, and the reproducing test is
banked as permanent regression protection. This is the same `route-failure →
fix-agent` machinery as Trigger A — a bug report is just another way to produce a
red check (the signal), so no new coordination primitives are needed.

Nothing auto-merges. Every escalation, cap, quarantine, and override leaves a
labeled, actor-attributed, TTL'd trace — the operator's "why is this blocked / what
was tried / what failed" readout.

---

## 7. Error handling & edge cases

**Principle:** every autonomous loop has a bound; every bound leaves a visible
trace when it trips. No silent caps.

### 7.1 Agent & cost runaway
- Fix-agent can't converge → hit `maxRetries` → stop, `ns:needs-human`, attach all
  attempt diffs, release claim.
- **Self-recursion guard:** `detect-changes` ignores commits authored by
  `ns:actor/*` on fix branches. A failing agent PR escalates to a human; it never
  spawns another agent.
- Per-attempt token ceiling (`fix.maxTokens`); repo-wide cap
  (`fix.maxConcurrentClaims`) — excess failures queue as signals, not parallel agents.
- `author-tests` capped by `coverageGen.maxNewTestsPerRun`; remainder deferred and
  logged (never silently dropped).

### 7.2 Coordination hazards
- Two failures, same zone → claim acquire is atomic (label add fails if present);
  second queues. No concurrent edits to one zone.
- Claim TTL expiring mid-fix → active agent **renews** each attempt (renewal resets
  TTL); only a stuck/crashed agent's claim actually expires.
- Crashed agent lock → GC reclaims only on **TTL + stale renewal** (two conditions,
  never TTL alone), posts `ns:signal/reclaimed`, re-queues the failure. Active work
  is never reclaimed out from under an agent.
- Claim starvation (hot zone always busy) → age > `starvationThreshold` → escalate
  to `ns:needs-human` rather than spin.
- Overlapping zones → most-specific-wins → one owning claim per file.

### 7.3 Test-integrity hazards (product-critical)
- **Agent "fixes" by weakening/deleting a test** → `promote-regression` diff-guards
  reject any fix that deletes/skips tests or lowers assertions in
  `tests/regression/`. The blessed suite is immutable except by promotion.
- Agent edits source to match a wrong test → integration/system fixes may edit
  source, but a **human PR gate always applies** (nothing auto-merges).
- Flaky test promoted → promotion requires green on **N consecutive main runs**
  (`stabilityRuns`, default 2), not a single pass.
- Flaky test triggers needless fix-agent → `run-suite` retries once; only
  deterministic failures route. Flakes quarantined with `ns:signal/flaky`.
- Coverage-gate blocks a legit refactor removing code → trend compares ratios;
  honors `// ns:coverage-exempt` + PR-label override (operator override, logged
  with actor identity).

### 7.4 Infrastructure & config faults
- Adapter missing/misconfigured → `detect-changes` validates `adapter:` against
  zones; config schema validated first. Fail fast before any agent spend.
- New repo, no baseline coverage → gate runs in **ratchet-establish mode** (record
  baseline, don't block) on first run.
- Monorepo partial failure → per-zone check statuses independent; only the red zone
  routes; green zones still promote.
- Secret leak → hard block, no agent, `ns:needs-human`.
- Claude API / Action outage → infra failure (not a test failure); retry with
  backoff; on exhaustion leave `ns:signal/agent-unavailable`, do **not** consume a
  fix attempt.
- Consumer misconfig (bad routing glob) → schema + dry-run validation refuses to
  start rather than mis-route.

---

## 8. Engine strategy (the reasoning-engine seam)

The **reasoning steps** (`author-tests`, `fix-agent`, and the routing decision) run
behind a single internal engine interface (`engine/`). The **deterministic
governance layer** (gate, promote, claims, GC, secret-scan) is identical regardless
of engine — that layer is Northstar's moat.

GitHub's own framing draws the same line Northstar splits on: **reusable actions =
deterministic CI; agentic workflows = reasoning tasks.** Two engine implementations
are contemplated behind the seam:

- **`claude-code` (v1, default):** call the Claude Code GitHub Action directly. We
  own the prompt, tool scope, retry accounting, and PR plumbing. Proven, full
  control, ships now. Portable across any Actions + Claude Code environment.
- **`gh-aw` (evaluation):** express reasoning steps as **GitHub Agentic Workflows**
  (Markdown outcome files) and let GitHub's runtime own the agent loop, tool
  sandboxing, and PR creation. Lower maintenance; but couples a core dependency to a
  **preview** product and inherits its limits.

**Decision:** do **not** commit either way in v1 beyond shipping `claude-code`.
Keep the engine swappable behind the seam.

**Open evaluation item (for the implementation plan):** spike `gh-aw` against one
action (`author-tests`) and verify it exposes:
1. tool-scoping tight enough for the claim model, and
2. retry / turn visibility sufficient for the `fix.maxTokens` / `maxRetries` cost
   caps.
If both hold, `gh-aw` becomes an alternate (or default) engine; if not, stay
direct. Same discipline as the substrate-backed-mode seam: design the boundary now,
choose the implementation with evidence later.

---

## 9. Testing strategy (Northstar tests itself)

A testing product must pass its own pipeline. Five layers:

1. **Unit tests — extracted logic** (`lib/`, no network): zone resolution
   (most-specific-wins, glob semantics), coverage-delta math + ratchet-establish,
   the claim/GC state machine (acquire-atomic, renewal-resets-TTL, reclaim only on
   TTL+stale), promotion diff-guards + `stabilityRuns`. Run by our own js-ts adapter
   (dogfooding).
2. **Adapter contract tests:** one shared suite asserts the four-command interface's
   JSON shape, run against js-ts (Jest fixture **and** `node:test` fixture **and**
   Vitest fixture) and python (pytest/Django) as it lands. New adapter = pass the
   contract = done.
3. **Substrate conformance:** claim/signal JSON validated against the substrate's
   published schemas + six properties.
4. **Integration tests — fixture consumer repo** (`examples/consumer-repo/`, a
   deliberately broken monorepo): assert **traces produced**, not just exit codes
   (unit failure → correct claim + fixer role; gap → author writes `tests/new/`;
   flaky → `ns:signal/flaky`, no agent; secret → hard block, no agent). Run locally
   with **`act`** or a disposable sandbox repo. The engine step is **stubbed by
   default** (fake agent applies a known-good patch) for determinism/cost; a nightly
   **live-agent** job runs the real engine against the fixture to catch drift.
5. **End-to-end dogfooding — real projects** (see §10).

**Release gate:** cuttable only when unit + contract + conformance + integration
pass, `act` E2E passes with the stubbed engine, the nightly live-agent job passed
last run, and all dogfood repos are green on latest main. Northstar runs its own
pipeline on itself (its `northstar.config.yml` lives in this repo).

---

## 10. Dogfood / proof projects

All three are live internal projects; they double as case studies for the
consulting offering.

| Project | Stack | CI today | Role | Notes |
|---|---|---|---|---|
| **ALTO Works** | React/TS (Jest) + Django/Python monorepo, cli/sdk/infra | dataclenz-convention workflows | Dogfood #1 — mixed TS+Py exercises zone routing + both adapters | Already hand-rolls `coverage:top-misses` ranking + `p0-closure` regression subsets — Northstar automates exactly this |
| **A11yPlus** | Django/Python `api` (pytest) + Node `a11y-monitor` (`node:test`) | none | Dogfood #2 — greenfield install; forces `node:test` runner + python adapter | Has evals (out of scope) |
| **Council Principis** | Python backend (pytest/Lambda) + React/Vite/TS frontend (**Vitest**) + `pi-client` (Pi hardware) | none | Dogfood #3 — greenfield; forces **Vitest** runner; `pi-client` = non-gated zone | `TESTING.md` already mandates "pytest must stay green at all times" — Northstar's discipline, codified |

Combined, they require the js-ts adapter to support **Jest + Vitest + node:test**
and make the **Python adapter a day-one/v1.1 necessity**, and they validate
path-partitioned **zone routing** on real monorepos.

---

## 11. Operational cost model

Two meters. Pricing is current as of 2026-07-18.

**1. GitHub Actions minutes (fixed floor, paid every run).** Linux runners bill
**$0.008/min** on private repos (public repos free), with a monthly free tier
(~2,000–3,000 min by plan). Unit tests ~1–3 min; Playwright/E2E and docker-compose
system tests ~5–15 min each. Independent of the AI.

**2. Claude tokens (variable — only when an agent runs).** The key economic fact:
**agents fire only on a failure, a coverage gap, or a promotion — not on green
PRs**, which cost zero tokens. The `engine.models` per-role config is the biggest
lever.

| Model | Input $/1M | Output $/1M | Default role |
|---|---|---|---|
| Opus 4.8 (`claude-opus-4-8`) | $5.00 | $25.00 | `fix` (hard integration/system fixes) |
| Sonnet 5 (`claude-sonnet-5`) | $3.00 ($2.00 intro→2026-08-31) | $15.00 ($10.00 intro) | `author` (test generation, routine fixes) |
| Haiku 4.5 (`claude-haiku-4-5`) | $1.00 | $5.00 | `route` (failure classification) |

**Prompt caching:** cache reads ≈ 0.1× input, writes 1.25× (5-min) / 2× (1-hr).
A fix-agent re-reads the same repo/test context across bounded retries, so caching
turns most input into ~0.1× reads — a **60–80% input-cost cut** on multi-attempt
loops.

**Worked example — one fix-agent invocation** (~300K input + ~40K output):
- Opus 4.8, uncached: ~$1.50 + $1.00 = **~$2.50/attempt** → ~**$5** at `maxRetries: 2`.
- With caching (attempts 2+ at 0.1×): ~**$3.30** for the loop.
- Sonnet 5 (intro): ~$1.00/attempt → ~**$2** for the loop.

**Monthly estimate — mid-size repo** (200 PRs/mo, ~30% trigger an agent, ~1.5
invocations each, mixed ~$2.50/invocation):
- Agent tokens: 200 × 0.30 × 1.5 × $2.50 ≈ **~$225/mo**
- CI minutes: ~200 × ~8 min × $0.008 ≈ **~$13/mo** over free tier (often $0)
- **Total ≈ ~$240/mo**, dominated by agent tokens, scaling linearly with failure
  rate and the caps.

**Cost levers (all already in the design):**
1. **Per-role model tier** (`engine.models`) — Haiku route, Sonnet author, Opus fix.
2. **Hard caps** (§4.4/§7.1) — `fix.maxRetries`, `fix.maxTokens`,
   `fix.maxConcurrentClaims`, `coverageGen.maxNewTestsPerRun`.
3. **Prompt caching** of repo/test context across retries.
4. **Agents-only-on-failure** — green PRs cost only CI minutes; the gate and
   secret-scan run without any model call.
5. **`gh-aw` engine** (if adopted) offloads harness overhead to GitHub.

Net: **~$0 for the common green path**; a bounded, config-tunable token spend on
the failure path (low-hundreds/month for a mid-size active repo).

---

## 12. Observability & monitoring

Monitoring is largely **aggregation of traces the pipeline already emits** —
inspectability and multi-surface readout are two of the substrate's six mandatory
properties, so every stage already leaves a labeled, actor-attributed, TTL'd trace.
No new coordination primitives; metrics live in the client's repo (portable,
self-hosted, consistent with the no-hosted-SaaS stance).

**Six signals:**

| Signal | Source trace | Why |
|---|---|---|
| Pipeline health | check-run pass/fail per `zone × layer`, run duration | Is the gate green? Where do failures cluster? |
| Coverage trend | coverage artifacts over time | Quality ratcheting up or eroding? |
| Agent effectiveness | `fix-agent` green vs. `ns:needs-human`, retries-to-green | Fixing, or just escalating? |
| Cost | tokens per run/role/repo (§11), CI minutes | Within configured caps? |
| Coordination health | active `ns:claim/*`, claim age, GC `ns:signal/reclaimed`, `ns:signal/flaky` | Stuck agents, starvation, flake hotspots |
| Regression growth | `promote-regression` commits, blessed-suite size | Is the safety net accumulating? |

**Tiered delivery (config-toggled, `monitoring:` block):**
- **Tier 0 — per-run (built-in):** GitHub **Step Summary** + PR comment with this
  run's result, coverage delta, agent action, tokens spent. Immediate operator
  readout.
- **Tier 1 — repo dashboard (default):** a scheduled **`northstar-metrics.yml`**
  (sibling to `northstar-gc.yml`) rolls up the trace history — each run appends one
  structured JSON line (run id, zone, layer, result, coveragePct, tokens, claim
  events) to a metrics artifact / `northstar-metrics` branch; the rollup renders
  trend dashboards (coverage, fix-success rate, cost/week, flake list) to a markdown
  artifact or GitHub Pages. Pure GitHub primitives.
- **Tier 2 — external exporters (opt-in):** the same metric stream pushes to
  **OpenTelemetry / CloudWatch / Datadog** via `monitoring.exporter` — a consulting
  upsell; for AWS clients it fits existing CloudWatch tooling.

**Daily digest.** `northstar-metrics.yml` also posts a once-a-day summary (as an
issue comment, and/or emailed via the exporter) — e.g. *"yesterday: 12 PRs,
coverage 82%→83%, 3 bugs auto-fixed, 1 escalated, 2 tests promoted, $6 spent."*
The dashboard (Tier 1) is the always-current site; the digest is the push you don't
have to go look for.

### 12.1 Agent / model health (drift detection)

Distinct from pipeline health: *is the AI itself still doing good work?* Model
providers change behavior and prompts regress — this view catches that **before
clients feel it**.

| Health signal | Source | Degradation reads as |
|---|---|---|
| **Nightly canary** (primary) | §9 live-agent job runs the real engine against the deliberately-broken `examples/consumer-repo` fixture | Canary red = the model can no longer fix known bugs → page the maintainer, freeze releases |
| **Fix success rate** | `fix-agent` green vs. `ns:needs-human` over time | Falling → model/prompt struggling |
| **Human-acceptance rate** | agent PRs merged vs. closed-unmerged | Rising rejections → quality drop |
| **Guard-trip rate** | §7.3 diff-guard rejections (agent tried to weaken/skip a test) | Rising → model misbehaving/gaming the gate |
| **Retries-to-green & cost-per-fix** | attempt counts + tokens per successful fix | Rising → efficiency regression |

The **nightly canary is the early-warning system**: because it runs the real model
on a fixture with *known* bugs and a *known* good outcome, a red canary is an
unambiguous "the model stopped working" signal independent of any client's traffic.
Per-role tiers (`engine.models`) are validated the same way, so a regression in any
one role (route/author/fix) is isolated.

**Alerting** generalizes the reference repos' trusted `notify-on-failure.yml`
dedup-labeled-issue pattern: open/label an issue when `fix-agent` escalation rate
crosses `alerts.escalationRate`, coverage trend goes negative on main, claim age
exceeds `starvationThreshold`, or the **nightly canary fails**.

**Design footprint:** one new scheduled workflow (`northstar-metrics.yml`), the
daily digest + agent-health rollup, the `monitoring:` config block, and a read model
over existing traces (plus the already-planned nightly canary from §9) — no new
primitives.

---

## 13. Deferred / out of scope

Consolidated so it isn't scattered across §2/§8/§14/§15.

**Deferred to a later version (planned; a seam already exists):**
- **Python adapter** (pytest/Django/Lambda) — **v1.1 fast-follow** (all three
  dogfood repos need it). Adapter boundary makes it cheap.
- **Substrate-backed mode** (run the coordination-substrate HTTP service) — future
  upsell tier; `claims.sh` indirection swaps the impl behind fixed call sites.
- **Additional runners/languages** beyond JS/TS + Python — pass the adapter contract
  suite = done.
- **`auto-commit` fix mode** — config-available now, off by default (safe default is
  PR).

**Under evaluation (decide with evidence, not now):**
- **`gh-aw` engine** — build on GitHub Agentic Workflows vs. direct Claude Code.
  Spike `author-tests` in the implementation plan; adopt only if tool-scoping +
  retry visibility meet the claim model and cost caps (§8).

**Explicitly out of scope (excluded, not deferred):**
- **Eval harnesses** (distinct from tests) — Northstar tests behavior, not model-eval
  quality.
- **Non-CI-testable edge targets** — e.g. Council Principis `pi-client` (Pi voice
  hardware): a non-gated zone with no adapter, not something we test.
- **Hosted SaaS / managed service** — excluded by the reusable-package decision; the
  substrate-backed *mode* is the only managed piece and is opt-in.

---

## 14. Roadmap

- **v1:** package skeleton (Approach C), js-ts adapter (Jest/Vitest/node:test +
  Playwright), coordination model on GitHub primitives (signals/claims/induction,
  zones, TTL-GC), coverage hard-gate + trend, directory/tag regression promotion
  with guards, `claude-code` engine, **bug-intake door (reproduce-first)**,
  full-product stages (secret-scan, assign-reviewer, optional ECR deploy),
  monitoring Tier 0–1 + daily digest + agent-health/nightly-canary. Dogfood on ALTO
  frontend + Council Principis frontend.
- **v1.1:** Python adapter (pytest/Django/Lambda). Dogfood on all three backends.
- **Evaluation track:** `gh-aw` engine spike (§8).
- **Future tier:** substrate-backed mode (HTTP service) + monitoring Tier 2
  exporters as upsells; default GitHub-native mode needs nothing.

---

## 15. Open questions / decisions to revisit

1. `gh-aw` engine viability (§8) — resolve during implementation via the spike.
2. Whether Northstar is published as a public marketplace package, a private
   template, or a per-client vendored copy (affects versioning/distribution).
3. Pricing/packaging of the consulting engagement vs. the package itself
   (out of scope for this technical spec).
4. Exact prompt library structure for fixer roles (`prompts/*`) — deferred to the
   implementation plan.
