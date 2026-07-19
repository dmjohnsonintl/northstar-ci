'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  fromGhRuns,
  rollup,
  coverageSeries,
  agentHealth,
  renderDashboard,
  renderDigest,
} = require('./metrics');

const NOW = '2026-07-18T00:00:00Z';
const ago = (days) => new Date(Date.parse(NOW) - days * 86400000).toISOString();

const SAMPLE = [
  { databaseId: 1, workflowName: 'Northstar pipeline', conclusion: 'success', status: 'completed', event: 'push', createdAt: ago(1), updatedAt: new Date(Date.parse(ago(1)) + 90000).toISOString() },
  { databaseId: 2, workflowName: 'Northstar pipeline', conclusion: 'failure', status: 'completed', event: 'pull_request', createdAt: ago(2), updatedAt: new Date(Date.parse(ago(2)) + 60000).toISOString() },
  { databaseId: 3, workflowName: 'bugintakedemo', conclusion: 'success', status: 'completed', event: 'issues', createdAt: ago(3), updatedAt: new Date(Date.parse(ago(3)) + 120000).toISOString() },
  { databaseId: 4, workflowName: 'Northstar pipeline', conclusion: '', status: 'in_progress', event: 'push', createdAt: ago(0), updatedAt: ago(0) },
  { databaseId: 5, workflowName: 'ci', conclusion: 'success', status: 'completed', event: 'push', createdAt: ago(30), updatedAt: ago(30) }, // outside 7d window
];

test('fromGhRuns normalizes conclusion, event, and duration', () => {
  const recs = fromGhRuns(SAMPLE);
  assert.equal(recs[0].result, 'passed');
  assert.equal(recs[1].result, 'failed');
  assert.equal(recs[3].result, 'pending');
  assert.equal(recs[0].durationMs, 90000);
  assert.equal(recs[0].trigger, 'push');
  assert.equal(recs[0].workflow, 'Northstar pipeline');
});

test('rollup requires now', () => {
  assert.throws(() => rollup([], {}), /now/);
});

test('rollup windows by time and computes pass rate', () => {
  const rl = rollup(fromGhRuns(SAMPLE), { now: NOW, sinceDays: 7 });
  assert.equal(rl.pipeline.total, 4); // #5 (30d ago) excluded
  assert.equal(rl.pipeline.completed, 3); // #4 in_progress not completed
  assert.equal(rl.pipeline.passed, 2);
  assert.equal(rl.pipeline.failed, 1);
  assert.equal(rl.pipeline.passRate, 66.7);
  assert.equal(rl.pipeline.byWorkflow['Northstar pipeline'].total, 3);
  assert.equal(rl.pipeline.byWorkflow['bugintakedemo'].passed, 1);
});

test('rollup median duration', () => {
  const rl = rollup(fromGhRuns(SAMPLE), { now: NOW, sinceDays: 7 });
  // completed durations: 90000, 60000, 120000 -> median 90000
  assert.equal(rl.pipeline.medianDurationMs, 90000);
});

test('rollup handles an empty set without NaN', () => {
  const rl = rollup([], { now: NOW });
  assert.equal(rl.pipeline.total, 0);
  assert.equal(rl.pipeline.passRate, null);
});

test('coverageSeries sorts, computes deltas', () => {
  const cov = coverageSeries([
    { date: ago(1), linePct: 83.0 },
    { date: ago(5), linePct: 80.0 },
    { date: ago(3), linePct: 81.5 },
  ]);
  assert.equal(cov.first, 80);
  assert.equal(cov.latest, 83);
  assert.equal(cov.deltaFromFirst, 3);
  assert.equal(cov.deltaFromPrev, 1.5);
  assert.equal(cov.series.length, 3);
});

test('a flat coverage delta renders as ±0, not the no-data dash', () => {
  const model = {
    rollup: rollup(fromGhRuns(SAMPLE), { now: NOW, sinceDays: 7 }),
    coverage: coverageSeries([{ date: ago(3), linePct: 75 }, { date: ago(1), linePct: 75 }]),
    agent: agentHealth({}),
    generatedAt: NOW,
  };
  const md = renderDashboard(model);
  assert.match(md, /±0/);
  assert.doesNotMatch(md, /— 0/);
});

test('coverageSeries empty is safe', () => {
  const cov = coverageSeries([]);
  assert.equal(cov.latest, null);
  assert.equal(cov.deltaFromFirst, null);
});

test('agentHealth derives success + acceptance rates, absent -> null', () => {
  const a = agentHealth({ fixPrsOpened: 3, escalations: 1, fixPrsMerged: 2, fixPrsClosedUnmerged: 0, reproduced: 4 });
  assert.equal(a.fixSuccessRate, 75);
  assert.equal(a.humanAcceptanceRate, 100);
  assert.equal(a.reproduced, 4);
  assert.equal(a.promoted, null); // not provided
  const empty = agentHealth({});
  assert.equal(empty.fixSuccessRate, null);
});

test('renderDashboard contains the key numbers and no fabricated cost zeros', () => {
  const model = {
    rollup: rollup(fromGhRuns(SAMPLE), { now: NOW, sinceDays: 7 }),
    coverage: coverageSeries([{ date: ago(5), linePct: 80 }, { date: ago(1), linePct: 83 }]),
    agent: agentHealth({ fixPrsOpened: 3, escalations: 1, reproduced: 2, needsInfo: 1, promoted: 5, canary: 'green' }),
    generatedAt: NOW,
    repo: 'dmjohnsonintl/northstar-ci',
  };
  const md = renderDashboard(model);
  assert.match(md, /# Northstar status — dmjohnsonintl\/northstar-ci/);
  assert.match(md, /Green rate:\*\* 66\.7%/);
  assert.match(md, /Latest:\*\* 83%/);
  assert.match(md, /Fix success rate:\*\* 75%/);
  assert.match(md, /🟢 green/);
  assert.match(md, /Not yet wired/); // honest about deferred cost/coordination signals
});

test('renderDigest is a single informative line', () => {
  const model = {
    rollup: rollup(fromGhRuns(SAMPLE), { now: NOW, sinceDays: 7 }),
    coverage: coverageSeries([{ date: ago(5), linePct: 80 }, { date: ago(1), linePct: 83 }]),
    agent: agentHealth({ fixPrsOpened: 3, escalations: 1, promoted: 5 }),
  };
  const line = renderDigest(model);
  assert.ok(!line.includes('\n'), 'single line');
  assert.match(line, /Northstar \(last 7d\): 4 runs, 66\.7% green, coverage 80%→83%/);
  assert.match(line, /3 auto-fixed, 1 escalated, 5 promoted/);
});

test('renderers are deterministic for the same inputs', () => {
  const build = () => renderDashboard({
    rollup: rollup(fromGhRuns(SAMPLE), { now: NOW, sinceDays: 7 }),
    coverage: coverageSeries([{ date: ago(1), linePct: 83 }]),
    agent: agentHealth({ fixPrsOpened: 1, escalations: 0 }),
    generatedAt: NOW,
  });
  assert.equal(build(), build());
});
