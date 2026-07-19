'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./substrate');
const { conforms, validateShape, checkProperties, loadSchema } = require('./conformance');

const NOW = '2026-07-18T12:00:00Z';
const plus = (secs) => new Date(Date.parse(NOW) + secs * 1000).toISOString();

// ---- Addressing / identity / labels ----
test('labels and actor tags follow the ns:* namespace', () => {
  assert.equal(S.zoneClaimLabel('frontend'), 'ns:claim/zone/frontend');
  assert.equal(S.claimBranch('frontend'), 'ns/claim/frontend');
  assert.equal(S.signalLabel('coverage-gap'), 'ns:signal/coverage-gap');
  assert.equal(S.actorTag('fixer', '12345'), 'ns:actor/fixer@12345');
});

// ---- Acquire is atomic: same zone queues (§7.2) ----
test('acquire on a free zone succeeds; a second on the same zone queues', () => {
  const first = S.acquire([], { zone: 'api', role: 'fixer', runId: '1', ttlSeconds: 3600, now: NOW });
  assert.equal(first.ok, true);
  assert.equal(first.claim.status, 'active');
  const second = S.acquire([first.claim], { zone: 'api', role: 'fixer', runId: '2', ttlSeconds: 3600, now: plus(5) });
  assert.equal(second.ok, false);
  assert.equal(second.status, 'queued');
  assert.equal(second.holder.actor.runId, '1');
});

test('a different zone is independently claimable', () => {
  const held = S.newClaim({ zone: 'api', role: 'fixer', runId: '1', ttlSeconds: 3600, now: NOW });
  const other = S.acquire([held], { zone: 'frontend', role: 'fixer', runId: '2', ttlSeconds: 3600, now: NOW });
  assert.equal(other.ok, true);
});

// ---- Renewal resets the TTL clock (§7.2) ----
test('renewal resets TTL: a renewed claim is not expired past the original TTL', () => {
  const c = S.newClaim({ zone: 'api', role: 'fixer', runId: '1', ttlSeconds: 3600, now: NOW });
  assert.equal(S.isExpired(c, { now: plus(3700) }), true); // 1h5m, no renewal -> expired
  const renewed = S.renewClaim(c, { now: plus(3500) }); // renewed just before expiry
  assert.equal(S.isExpired(renewed, { now: plus(3700) }), false); // only 200s since renewal
  assert.equal(renewed.createdAt, c.createdAt); // age clock (starvation) unaffected
});

// ---- Reclaim ONLY on TTL + stale, never TTL alone (§7.2) ----
test('reclaim requires BOTH expired AND stale (two conditions)', () => {
  const c = S.newClaim({ zone: 'api', role: 'fixer', runId: '1', ttlSeconds: 3600, now: NOW });
  const staleAfterSeconds = 7200; // 2h grace beyond TTL
  // Past TTL (1h) but within the stale window (2h): expired, NOT reclaimable.
  assert.equal(S.isExpired(c, { now: plus(4000) }), true);
  assert.equal(S.isStale(c, { now: plus(4000), staleAfterSeconds }), false);
  assert.equal(S.isReclaimable(c, { now: plus(4000), staleAfterSeconds }), false);
  // Past the stale window: both hold -> reclaimable.
  assert.equal(S.isReclaimable(c, { now: plus(7300), staleAfterSeconds }), true);
});

// ---- Starvation escalates rather than spins (§7.2) ----
test('a claim older than the starvation threshold is starved', () => {
  const c = S.newClaim({ zone: 'api', role: 'fixer', runId: '1', ttlSeconds: 3600, now: NOW });
  assert.equal(S.isStarved(c, { now: plus(1000), starvationThresholdSeconds: 21600 }), false);
  assert.equal(S.isStarved(c, { now: plus(22000), starvationThresholdSeconds: 21600 }), true);
});

// ---- Signal mortality ----
test('signals expire past their TTL', () => {
  const sig = S.newSignal({ type: 'hot-area', zone: 'api', now: NOW, ttlSeconds: 86400 });
  assert.equal(S.signalExpired(sig, { now: plus(80000) }), false);
  assert.equal(S.signalExpired(sig, { now: plus(90000) }), true);
});

// ---- GC sweep classification + reclaimed-signal emission ----
test('sweep reclaims crashed claims, starves busy ones, expires old signals', () => {
  const crashed = S.newClaim({ zone: 'api', role: 'fixer', runId: '1', ttlSeconds: 3600, now: NOW });
  const busy = S.renewClaim(
    S.newClaim({ zone: 'frontend', role: 'fixer', runId: '2', ttlSeconds: 3600, now: NOW }),
    { now: plus(21000) }, // renewed recently -> not reclaimable, but old createdAt -> starved
  );
  const freshSig = S.newSignal({ type: 'coverage-gap', zone: 'api', now: plus(21500), ttlSeconds: 86400 });
  const oldSig = S.newSignal({ type: 'hot-area', zone: 'api', now: NOW, ttlSeconds: 3600 });

  const res = S.sweep([crashed, busy, freshSig, oldSig], {
    now: plus(22000),
    staleAfterSeconds: 7200,
    starvationThresholdSeconds: 21600,
  });
  assert.equal(res.reclaimClaims.length, 1);
  assert.equal(res.reclaimClaims[0].zone, 'api');
  assert.equal(res.starveClaims.length, 1);
  assert.equal(res.starveClaims[0].zone, 'frontend');
  assert.equal(res.expireSignals.length, 1);
  assert.equal(res.expireSignals[0].type, 'hot-area');
  assert.equal(res.keep.includes(freshSig), true);
  // A reclaimed signal is emitted so the failure can be re-queued (readout).
  assert.equal(res.emit.length, 1);
  assert.equal(res.emit[0].type, 'reclaimed');
  assert.equal(res.emit[0].zone, 'api');
});

// ---- Conformance: shape + six mandatory properties ----
test('a well-formed claim conforms and evidences all six properties', () => {
  const c = S.newClaim({ zone: 'api', role: 'fixer', runId: '99', ttlSeconds: 3600, now: NOW });
  const r = conforms(c);
  assert.equal(r.ok, true, JSON.stringify(r.missing));
  for (const p of ['mortality', 'actorIdentity', 'zoneAddressing', 'inspectability', 'override', 'readout']) {
    assert.equal(r.properties[p], true, `property ${p}`);
  }
});

test('a well-formed signal conforms', () => {
  const sig = S.newSignal({ type: 'coverage-gap', zone: 'api', now: NOW });
  assert.equal(conforms(sig).ok, true);
});

test('conformance rejects records missing mortality or actor identity', () => {
  const noTtl = { kind: 'claim', zone: 'api', actor: { role: 'fixer', runId: '1' }, createdAt: NOW, renewedAt: NOW, status: 'active' };
  assert.equal(conforms(noTtl).ok, false);
  assert.ok(conforms(noTtl).missing.includes('mortality'));
  const noActor = S.newClaim({ zone: 'api', role: 'fixer', runId: '1', ttlSeconds: 3600, now: NOW });
  delete noActor.actor;
  const r = conforms(noActor);
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes('actorIdentity'));
});

test('validateShape stays in sync with the published schema required keys', () => {
  // The structural validator must enforce exactly the schema-declared required keys.
  const claimSchema = loadSchema('claim');
  const c = S.newClaim({ zone: 'api', role: 'fixer', runId: '1', ttlSeconds: 3600, now: NOW });
  for (const key of claimSchema.required) {
    const broken = { ...c };
    delete broken[key];
    assert.equal(validateShape(broken).ok, false, `removing ${key} should fail validation`);
  }
  assert.equal(validateShape(c).ok, true);
});

test('checkProperties is total (never throws) on malformed input', () => {
  assert.doesNotThrow(() => checkProperties({}));
  assert.equal(checkProperties({}).mortality, false);
});
