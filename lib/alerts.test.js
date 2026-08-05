'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAlerts } = require('./alerts');

const NOW = '2026-07-22T00:00:00Z';
const ago = (s) => new Date(Date.parse(NOW) - s * 1000).toISOString();
const T = { escalationRate: 0.5, coverageDeltaMin: 0, claimAgeSeconds: 21600 };
const find = (out, rule) => out.find((a) => a.rule === rule);

test('canary: red fires (page severity), green clears, null is omitted', () => {
  const red = evaluateAlerts({ canary: 'red' }, T, { now: NOW });
  assert.equal(find(red, 'canary').state, 'firing');
  assert.equal(find(red, 'canary').severity, 'page');

  const green = evaluateAlerts({ canary: 'green' }, T, { now: NOW });
  assert.equal(find(green, 'canary').state, 'clear');

  const none = evaluateAlerts({ canary: null }, T, { now: NOW });
  assert.equal(find(none, 'canary'), undefined);
});

test('escalation-rate: over threshold fires, under clears, missing omitted', () => {
  const hot = evaluateAlerts({ escalation: { opened: 1, escalations: 4 } }, T, { now: NOW }); // 4/5 = 0.8
  assert.equal(find(hot, 'escalation-rate').state, 'firing');

  const ok = evaluateAlerts({ escalation: { opened: 9, escalations: 1 } }, T, { now: NOW }); // 0.1
  assert.equal(find(ok, 'escalation-rate').state, 'clear');

  const missing = evaluateAlerts({ escalation: null }, T, { now: NOW });
  assert.equal(find(missing, 'escalation-rate'), undefined);

  const zeroActivity = evaluateAlerts({ escalation: { opened: 0, escalations: 0 } }, T, { now: NOW });
  assert.equal(find(zeroActivity, 'escalation-rate'), undefined); // no denominator → unknown
});

test('coverage-trend: negative delta fires, non-negative clears, null omitted', () => {
  const drop = evaluateAlerts({ coverageDeltaFromPrev: -0.3 }, T, { now: NOW });
  assert.equal(find(drop, 'coverage-trend').state, 'firing');

  const flat = evaluateAlerts({ coverageDeltaFromPrev: 0 }, T, { now: NOW });
  assert.equal(find(flat, 'coverage-trend').state, 'clear');

  const none = evaluateAlerts({ coverageDeltaFromPrev: null }, T, { now: NOW });
  assert.equal(find(none, 'coverage-trend'), undefined);
});

test('claim-starvation: an old claim fires, fresh claims clear, empty omitted', () => {
  const old = evaluateAlerts({ claims: [{ createdAt: ago(30000), zone: 'src' }] }, T, { now: NOW }); // >21600
  assert.equal(find(old, 'claim-starvation').state, 'firing');

  const fresh = evaluateAlerts({ claims: [{ createdAt: ago(100), zone: 'src' }] }, T, { now: NOW });
  assert.equal(find(fresh, 'claim-starvation').state, 'clear');

  const empty = evaluateAlerts({ claims: [] }, T, { now: NOW });
  assert.equal(find(empty, 'claim-starvation'), undefined);
});

test('every firing alert carries a stable title and a non-empty body', () => {
  const out = evaluateAlerts(
    { canary: 'red', escalation: { opened: 0, escalations: 3 }, coverageDeltaFromPrev: -1, claims: [{ createdAt: ago(99999), zone: 'api' }] },
    T,
    { now: NOW },
  );
  for (const a of out) {
    assert.equal(a.title, `Northstar alert: ${a.rule}`);
    assert.ok(a.body && a.body.length > 0);
  }
  assert.equal(out.length, 4);
});

// --- human-acceptance (spec §12.1: "agent PRs merged vs closed-unmerged") ---

test('human-acceptance: below threshold fires, at/above clears', () => {
  const bad = evaluateAlerts({ acceptance: { merged: 1, closedUnmerged: 9 } }, T, { now: NOW }); // 10%
  assert.equal(find(bad, 'human-acceptance').state, 'firing');
  assert.equal(find(bad, 'human-acceptance').severity, 'trend');
  assert.match(find(bad, 'human-acceptance').body, /10%/);

  const good = evaluateAlerts({ acceptance: { merged: 9, closedUnmerged: 1 } }, T, { now: NOW }); // 90%
  assert.equal(find(good, 'human-acceptance').state, 'clear');

  // Boundary: exactly at the threshold does NOT fire (strict <, matching coverage-trend).
  const edge = evaluateAlerts({ acceptance: { merged: 5, closedUnmerged: 5 } }, T, { now: NOW }); // 50%
  assert.equal(find(edge, 'human-acceptance').state, 'clear');
});

test('human-acceptance: omitted when absent or counts are null', () => {
  for (const model of [{}, { acceptance: null }, { acceptance: { merged: null, closedUnmerged: null } }]) {
    assert.equal(find(evaluateAlerts(model, T, { now: NOW }), 'human-acceptance'), undefined);
  }
});

test('human-acceptance: omitted below the sample floor — n=1 must not page', () => {
  // A single declined PR is a 0% acceptance rate. Firing on that would page the
  // first time anyone closes a fix for an ordinary reason.
  const one = evaluateAlerts({ acceptance: { merged: 0, closedUnmerged: 1 } }, T, { now: NOW });
  assert.equal(find(one, 'human-acceptance'), undefined);

  const three = evaluateAlerts({ acceptance: { merged: 0, closedUnmerged: 3 } }, T, { now: NOW });
  assert.equal(find(three, 'human-acceptance').state, 'firing', 'floor is inclusive at 3 decided');
});

test('human-acceptance: open PRs are not in the sample (undecided != rejected)', () => {
  // fixPrOutcomes excludes OPEN PRs, so a repo with 20 open and 2 decided stays
  // below the floor rather than being judged on the open ones.
  const model = { acceptance: { merged: 1, closedUnmerged: 1 } };
  assert.equal(find(evaluateAlerts(model, T, { now: NOW }), 'human-acceptance'), undefined);
});

test('human-acceptance: transitions both ways (the issue lifecycle depends on it)', () => {
  const firing = evaluateAlerts({ acceptance: { merged: 0, closedUnmerged: 5 } }, T, { now: NOW });
  const clear = evaluateAlerts({ acceptance: { merged: 5, closedUnmerged: 0 } }, T, { now: NOW });
  assert.equal(find(firing, 'human-acceptance').state, 'firing');
  assert.equal(find(clear, 'human-acceptance').state, 'clear');
  // Stable title across both, so firing→clear closes the SAME issue.
  assert.equal(find(firing, 'human-acceptance').title, find(clear, 'human-acceptance').title);
});

test('human-acceptance: thresholds are configurable', () => {
  const strict = { ...T, acceptanceMin: 0.9, acceptanceMinSample: 2 };
  const m = { acceptance: { merged: 8, closedUnmerged: 2 } }; // 80%
  assert.equal(find(evaluateAlerts(m, T, { now: NOW }), 'human-acceptance').state, 'clear');
  assert.equal(find(evaluateAlerts(m, strict, { now: NOW }), 'human-acceptance').state, 'firing');
});
