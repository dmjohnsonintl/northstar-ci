'use strict';
// Coordination substrate — the stigmergic state machine (spec §4, §7.2).
//
// Northstar adopts the Agent Coordination Substrate's vocabulary and semantics
// on GitHub primitives: advisory SIGNALS (labels), enforcement CLAIMS (a claim
// branch `ns/claim/<zone>` + `ns:claim/zone/<zone>` label), ACTOR identity, and
// MORTALITY (TTL + GC). This module is the PURE decision layer — no GitHub calls;
// callers pass `now` in so every decision is deterministic and unit-testable.
// The GitHub side (atomic ref-create as the lock, label as the inspectable
// shadow, GC mutations) lives in the actions/workflow that consume these.

function toMs(t) {
  if (t == null) return NaN;
  if (typeof t === 'number') return t;
  return Date.parse(t);
}
function iso(t) {
  const ms = toMs(t);
  if (!Number.isFinite(ms)) throw new Error('substrate: a valid `now` (ISO or ms) is required');
  return new Date(ms).toISOString();
}

// ---- Addressing (zone) + identity (actor) + inspectable labels ----

function zoneClaimLabel(zone) {
  return `ns:claim/zone/${zone}`;
}
function claimBranch(zone) {
  return `ns/claim/${zone}`;
}
function signalLabel(type) {
  return `ns:signal/${type}`;
}
function actorTag(role, runId) {
  return `ns:actor/${role}@${runId}`;
}

// ---- Record constructors ----

function newClaim({ zone, role, runId, ttlSeconds, now }) {
  if (!zone) throw new Error('newClaim: zone is required');
  const at = iso(now);
  return {
    kind: 'claim',
    zone,
    actor: { role: role || 'fixer', runId: String(runId != null ? runId : 'local') },
    ttlSeconds: ttlSeconds || 3600,
    createdAt: at,
    renewedAt: at,
    status: 'active',
  };
}

function newSignal({ type, zone, role, runId, ttlSeconds, now }) {
  if (!type) throw new Error('newSignal: type is required');
  return {
    kind: 'signal',
    type,
    zone: zone || null,
    actor: { role: role || 'system', runId: String(runId != null ? runId : 'local') },
    ttlSeconds: ttlSeconds || 86400,
    createdAt: iso(now),
  };
}

// Renewal RESETS the TTL clock (only renewedAt moves; createdAt — the age used
// for starvation — does not). This is what keeps an active agent's claim alive.
function renewClaim(claim, { now }) {
  return { ...claim, renewedAt: iso(now) };
}

// ---- Mortality math ----

function ageSeconds(record, { now }) {
  return (toMs(now) - toMs(record.createdAt)) / 1000;
}
function sinceRenewSeconds(claim, { now }) {
  return (toMs(now) - toMs(claim.renewedAt)) / 1000;
}
// Past its TTL (renewal clock).
function isExpired(claim, { now }) {
  return sinceRenewSeconds(claim, { now }) > claim.ttlSeconds;
}
// No renewal within the (longer) stale window — a distinct, second condition.
function isStale(claim, { now, staleAfterSeconds }) {
  const stale = staleAfterSeconds != null ? staleAfterSeconds : claim.ttlSeconds * 2;
  return sinceRenewSeconds(claim, { now }) > stale;
}
// GC reclaims ONLY when BOTH hold (never TTL alone) — §7.2. Kept as two ANDed
// booleans so the two-condition guarantee is explicit and independently tested.
function isReclaimable(claim, { now, staleAfterSeconds }) {
  return isExpired(claim, { now }) && isStale(claim, { now, staleAfterSeconds });
}
// A hot zone held/queued too long overall → escalate to a human rather than spin.
function isStarved(claim, { now, starvationThresholdSeconds }) {
  return ageSeconds(claim, { now }) > (starvationThresholdSeconds || 21600);
}
function signalExpired(signal, { now }) {
  return ageSeconds(signal, { now }) > signal.ttlSeconds;
}

// ---- Decisions ----

// Acquire is a DECISION here; atomicity is enforced by the GitHub ref-create in
// actions/claim. An active claim on the zone → queue (no collision).
function acquire(existingClaims, { zone, role, runId, ttlSeconds, now }) {
  const holder = (existingClaims || []).find((c) => c.zone === zone && c.status === 'active');
  if (holder) return { ok: false, status: 'queued', holder };
  return { ok: true, status: 'acquired', claim: newClaim({ zone, role, runId, ttlSeconds, now }) };
}

// The GC sweep: classify every live record. Reclaim (crashed agent) takes
// precedence over starve (busy-but-alive). Emits a `reclaimed` signal per
// reclaimed claim so the failure can be re-queued (readout).
function sweep(records, { now, staleAfterSeconds, starvationThresholdSeconds }) {
  const out = { expireSignals: [], reclaimClaims: [], starveClaims: [], keep: [], emit: [] };
  for (const r of records || []) {
    if (r.kind === 'signal') {
      if (signalExpired(r, { now })) out.expireSignals.push(r);
      else out.keep.push(r);
      continue;
    }
    if (r.kind === 'claim' && r.status === 'active') {
      if (isReclaimable(r, { now, staleAfterSeconds })) {
        out.reclaimClaims.push(r);
        out.emit.push(newSignal({ type: 'reclaimed', zone: r.zone, role: 'gc', runId: 'gc', now }));
      } else if (isStarved(r, { now, starvationThresholdSeconds })) {
        out.starveClaims.push(r);
      } else {
        out.keep.push(r);
      }
      continue;
    }
    out.keep.push(r);
  }
  return out;
}

// Human-readable one-liner (readout property).
function summarize(record) {
  if (record.kind === 'claim') {
    return `claim ${record.zone} by ${actorTag(record.actor.role, record.actor.runId)} (ttl ${record.ttlSeconds}s, ${record.status})`;
  }
  return `signal ${record.type}${record.zone ? ` @${record.zone}` : ''} by ${actorTag(record.actor.role, record.actor.runId)} (ttl ${record.ttlSeconds}s)`;
}

// Inspectable label for either record kind.
function labelFor(record) {
  return record.kind === 'claim' ? zoneClaimLabel(record.zone) : signalLabel(record.type);
}

module.exports = {
  zoneClaimLabel,
  claimBranch,
  signalLabel,
  actorTag,
  newClaim,
  newSignal,
  renewClaim,
  ageSeconds,
  sinceRenewSeconds,
  isExpired,
  isStale,
  isReclaimable,
  isStarved,
  signalExpired,
  acquire,
  sweep,
  summarize,
  labelFor,
};
