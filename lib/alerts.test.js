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
