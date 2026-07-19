# Coordination substrate (signals, claims, induction, GC)

Northstar adopts the [Agent Coordination Substrate](https://github.com/instagrim-dev/agent-coordination-substrate)'s
**vocabulary and semantics** on plain GitHub primitives — no runtime dependency on
its HTTP service (spec §4).

| Substrate concept | Northstar implementation | Mortal? |
|---|---|---|
| **Zone** | path glob (`frontend/**`) from config + CODEOWNERS | — |
| **Advisory signal** | label `ns:signal/<type>` (coverage-gap, hot-area, flaky, reclaimed, stale-bug…) | TTL |
| **Enforcement claim** | atomically-created branch `ns/claim/<zone>` + `ns:claim/zone/<zone>` label; metadata in `.northstar/claims/<zone>.json` | TTL |
| **Actor identity** | `ns:actor/<role>@<run-id>` on every claim/signal | — |
| **Mortality / GC** | scheduled `northstar-gc.yml` sweep | — |

## Why the lock is a branch, not a label
`ns:claim/zone/<zone>` as a *label* is idempotent — adding it twice succeeds, so two
runs could both think they hold the zone. The real lock is **creating the ref**
`ns/claim/<zone>` via the GitHub refs API, which returns **422 if it already
exists**. That is genuinely atomic: the second run is cleanly *queued*, never a
collision. The label is the human-visible shadow of the branch.

## The mortality rules (§7.2), enforced in `lib/substrate.js`
- **Renewal resets the TTL clock.** An active agent renews each attempt, so only a
  stuck/crashed agent's claim actually expires.
- **Reclaim requires TWO conditions — past TTL *and* stale renewal — never TTL
  alone.** A claim renewed one second late is not yanked out from under a live agent.
- **Starvation escalates.** A hot zone held past `starvation-seconds` opens a deduped
  `ns:needs-human` issue instead of spinning.

The decision logic is a pure, deterministic state machine (time is injected, never
`Date.now()`), unit-tested against every hazard above, and each record is validated
for **substrate conformance** — the six mandatory properties (mortality, actor
identity, zone addressing, inspectability, override, readout) plus the published
JSON Schemas in `schema/substrate/`.

## Pieces
- `lib/substrate.js` — state machine · `lib/conformance.js` + `schema/substrate/*` — conformance
- `actions/claim` — acquire (atomic) / renew / release
- `.github/workflows/northstar-gc.yml` — scheduled sweep (also `workflow_call`)

## Wired into the pipeline
- **Enforcement (claims):** the fix job acquires `ns/claim/<zone>` before fixing and
  releases after — concurrent fixes on one zone queue instead of colliding.
- **Advisory (signals):** the gate emits `ns:signal/hot-area` (touched zones, TTL 24h)
  and `ns:signal/coverage-gap` (on a gap) — to the step-summary readout always, and as
  PR labels best-effort.

## Not yet wired (next increment)
- **`ns:signal/flaky`** — needs `run-suite` retry-once (fail→retry→pass ⇒ quarantine,
  don't route to fix).
- **Signal-label GC via the issue timeline** — claims GC is live; expiring signal
  labels by TTL (reading label-add time from the timeline) is the next GC increment.
- **Standalone `route-failure` composite action** — its behavior is currently inlined
  in the pipeline (resolve zone → acquire claim).
