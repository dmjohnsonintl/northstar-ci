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

// --- adoption-stalled ---
// The fixtures are the two REAL incidents, replayed at injected timestamps. This is
// only possible because evaluateAlerts takes `now` as a parameter: a purity
// discipline adopted for testability turns out to buy time travel.

const A11Y = { repo: 'dmjohnsonintl/a11yplus', branch: 'ns/adopt-northstar', pr: 1,
               since: '2026-07-23T02:12:15Z', aheadBy: 1, behindBy: 0 };
const CP   = { repo: 'dmjohnsonintl/council-principis', branch: 'ns/adopt-northstar', pr: 44,
               since: '2026-07-23T01:17:05Z', aheadBy: 4, behindBy: 55 };
const AT = { ...T, adoptionAgeSeconds: 259200, adoptionBehindMax: 25 };
const at = (iso, model) => evaluateAlerts(model, AT, { now: iso });

test('adoption-stalled: replays the real incident — fires on 2026-08-02', () => {
  const a = find(at('2026-08-02T00:00:00Z', { adoptions: [A11Y, CP] }), 'adoption-stalled');
  assert.equal(a.state, 'firing');
  assert.equal(a.severity, 'trend');
  assert.match(a.body, /a11yplus/);
  assert.match(a.body, /council-principis/);
  assert.match(a.body, /55 commits behind/);
});

test('adoption-stalled: would NOT have cried wolf on day two (2026-07-25)', () => {
  // Both branches are ~2 days old and CP has not yet drifted (master was quiet
  // until 07-28), so nothing should fire.
  const quietCP = { ...CP, behindBy: 0 };
  const a = find(at('2026-07-25T00:00:00Z', { adoptions: [A11Y, quietCP] }), 'adoption-stalled');
  assert.equal(a.state, 'clear');
});

test('adoption-stalled: would have caught it on 2026-07-26 — the claim, asserted', () => {
  const quietCP = { ...CP, behindBy: 0 };
  // The branch was cut at 02:12:15Z, so three days elapses at 02:12Z on the 26th --
  // NOT midnight. Asserting the claim is what pinned it down; "Jul 26" was right to
  // the day and off by two hours.
  const before = find(at('2026-07-26T00:00:00Z', { adoptions: [A11Y, quietCP] }), 'adoption-stalled');
  assert.equal(before.state, 'clear', 'at 00:00Z only 2d21h have passed');

  const after = find(at('2026-07-26T03:00:00Z', { adoptions: [A11Y, quietCP] }), 'adoption-stalled');
  assert.equal(after.state, 'firing', 'a 3-day threshold catches the incident on Jul 26');
});

test('adoption-stalled: age alone fires (a11yplus was 0 commits behind)', () => {
  // No drift-based rule would ever have fired on this one.
  const a = find(at('2026-08-02T00:00:00Z', { adoptions: [A11Y] }), 'adoption-stalled');
  assert.equal(a.state, 'firing');
  assert.match(a.body, /0 commits behind/);
});

test('adoption-stalled: drift alone fires, even when young', () => {
  const youngButDrifted = { ...CP, since: '2026-08-01T00:00:00Z', behindBy: 55 };
  const a = find(at('2026-08-02T00:00:00Z', { adoptions: [youngButDrifted] }), 'adoption-stalled');
  assert.equal(a.state, 'firing');
});

test('adoption-stalled: a branch with no PR is still reported', () => {
  // The case a PR-watching rule cannot see at all.
  const noPr = { ...CP, pr: null, behindBy: 0 };
  const a = find(at('2026-08-02T00:00:00Z', { adoptions: [noPr] }), 'adoption-stalled');
  assert.equal(a.state, 'firing');
  assert.match(a.body, /never proposed/);
});

test('adoption-stalled: omitted when not configured, clear when configured-and-healthy', () => {
  for (const m of [{}, { adoptions: null }, { adoptions: [] }]) {
    assert.equal(find(evaluateAlerts(m, AT, { now: NOW }), 'adoption-stalled'), undefined);
  }
  // The sentinel: a configured repo with no adoption branch. Without this a merged
  // adoption empties the array -> omission -> its open issue could never close.
  const sentinel = { adoptions: [{ repo: 'dmjohnsonintl/a11yplus', branch: null }] };
  assert.equal(find(evaluateAlerts(sentinel, AT, { now: NOW }), 'adoption-stalled').state, 'clear');
});

test('adoption-stalled: transitions both ways, stable title', () => {
  const f = find(at('2026-08-02T00:00:00Z', { adoptions: [A11Y] }), 'adoption-stalled');
  const c = find(at('2026-08-02T00:00:00Z', { adoptions: [{ repo: A11Y.repo, branch: null }] }), 'adoption-stalled');
  assert.equal(f.state, 'firing');
  assert.equal(c.state, 'clear');
  assert.equal(f.title, c.title);
});
