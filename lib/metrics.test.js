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
  assert.match(md, /## Cost/);
  assert.match(md, /No engine cost records yet/); // honest fallback — this model has no cost records
  assert.doesNotMatch(md, /\$0\.0000/); // never a fabricated cost zero
});

test('rollup sums CI minutes over completed runs', () => {
  const rl = rollup(fromGhRuns(SAMPLE), { now: NOW, sinceDays: 7 });
  // completed durations in window: 90000 + 60000 + 120000 = 270000ms = 4.5min -> 5
  assert.equal(rl.pipeline.ciMinutes, 5);
});

test('dashboard renders coordination health + regression growth from traces', () => {
  const model = {
    rollup: rollup(fromGhRuns(SAMPLE), { now: NOW, sinceDays: 7 }),
    coverage: coverageSeries([{ date: ago(1), linePct: 83 }]),
    agent: agentHealth({ fixPrsOpened: 1, escalations: 0 }),
    coordination: { activeClaims: 2, flakySignals: 3, coverageGapSignals: 1, reclaimedSignals: 0 },
    regression: { promotions: 7 },
    generatedAt: NOW,
  };
  const md = renderDashboard(model);
  assert.match(md, /Active zone claims:\*\* 2/);
  assert.match(md, /Flake signals:\*\* 3/);
  assert.match(md, /Promotions \(window\):\*\* 7/);
  assert.match(md, /CI time \(window\):/);
  // Cost section renders and falls back honestly (this model has no `cost` records).
  assert.match(md, /## Cost/);
  assert.match(md, /No engine cost records yet/);
  assert.doesNotMatch(md, /coordination health \(claims\/flake\)/);
});

test('coordination/regression absent → dashes, never fabricated zeros', () => {
  const md = renderDashboard({
    rollup: rollup(fromGhRuns(SAMPLE), { now: NOW, sinceDays: 7 }),
    coverage: coverageSeries([]),
    agent: agentHealth({}),
    generatedAt: NOW,
  });
  assert.match(md, /Active zone claims:\*\* —/);
  assert.match(md, /Promotions \(window\):\*\* —/);
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

const { costFromRecords } = require('./metrics');

const REC_NOW = '2026-07-18T00:00:00Z';
const recAgo = (days, over) => ({
  createdAt: new Date(Date.parse(REC_NOW) - days * 86400000).toISOString(),
  ...over,
});

test('costFromRecords sums cost in-window and counts null-cost runs honestly', () => {
  const recs = [
    recAgo(1, { engine: 'claude-code', costUsd: 0.02, tokens: { input: 100, output: 50, cacheRead: 10 }, layer: 'unit' }),
    recAgo(2, { engine: 'claude-code', costUsd: 0.03, tokens: { input: 200, output: 60, cacheRead: 0 }, layer: 'system' }),
    recAgo(3, { engine: 'stub', costUsd: null, tokens: null, layer: 'unit' }),
    recAgo(30, { engine: 'claude-code', costUsd: 9.99, tokens: { input: 1, output: 1, cacheRead: 1 }, layer: 'unit' }), // outside window
  ];
  const c = costFromRecords(recs, { now: REC_NOW, sinceDays: 7 });
  assert.equal(c.runsTotal, 3);       // #4 excluded by window
  assert.equal(c.runsWithCost, 2);    // stub null-cost not counted as cost
  assert.equal(c.totalCostUsd, 0.05);
  assert.equal(c.costPerRun, 0.025);
  assert.deepEqual(c.tokens, { input: 300, output: 110, cacheRead: 10 });
  assert.equal(c.byLayer.unit.runs, 2);
  assert.equal(c.byLayer.unit.costUsd, 0.02);
  assert.equal(c.byLayer.system.costUsd, 0.03);
});

test('costFromRecords returns nulls (renders —) for no records', () => {
  const c = costFromRecords([], { now: REC_NOW });
  assert.equal(c.runsTotal, 0);
  assert.equal(c.totalCostUsd, null);
  assert.equal(c.costPerRun, null);
});

test('costFromRecords requires now', () => {
  assert.throws(() => costFromRecords([], {}), /now/);
});

test('renderDashboard shows the Cost section when records exist', () => {
  const model = {
    rollup: rollup([], { now: REC_NOW }),
    cost: costFromRecords([recAgo(1, { engine: 'claude-code', costUsd: 0.02, tokens: { input: 100, output: 50, cacheRead: 0 }, layer: 'unit' })], { now: REC_NOW, sinceDays: 7 }),
    generatedAt: REC_NOW,
  };
  const md = renderDashboard(model);
  assert.match(md, /## Cost/);
  assert.match(md, /\$0\.0200/);
});

test('renderDashboard Cost section falls back to — with no records', () => {
  const model = { rollup: rollup([], { now: REC_NOW }), cost: costFromRecords([], { now: REC_NOW }), generatedAt: REC_NOW };
  const md = renderDashboard(model);
  assert.match(md, /## Cost/);
  assert.match(md, /No engine cost records yet/);
});

const { canaryFromRuns } = require('./metrics');

test('canaryFromRuns: latest matching run wins, mapped to green/red', () => {
  const runs = [
    { workflowName: 'Northstar canary', conclusion: 'failure', createdAt: ago(3) },
    { workflowName: 'Northstar canary', conclusion: 'success', createdAt: ago(1) }, // latest
    { workflowName: 'Northstar pipeline', conclusion: 'failure', createdAt: ago(0) },
  ];
  assert.equal(canaryFromRuns(runs, { workflowName: 'Northstar canary' }), 'green');
});

test('canaryFromRuns: a red latest run reads red', () => {
  const runs = [
    { workflowName: 'Northstar canary', conclusion: 'success', createdAt: ago(2) },
    { workflowName: 'Northstar canary', conclusion: 'failure', createdAt: ago(1) }, // latest
  ];
  assert.equal(canaryFromRuns(runs, { workflowName: 'Northstar canary' }), 'red');
});

test('canaryFromRuns: no matching run → null (never red)', () => {
  const runs = [{ workflowName: 'Northstar pipeline', conclusion: 'failure', createdAt: ago(1) }];
  assert.equal(canaryFromRuns(runs, { workflowName: 'Northstar canary' }), null);
});

test('canaryFromRuns: latest run still pending → null', () => {
  const runs = [
    { workflowName: 'Northstar canary', conclusion: 'success', createdAt: ago(2) },
    { workflowName: 'Northstar canary', conclusion: '', createdAt: ago(0) }, // pending, newest
  ];
  assert.equal(canaryFromRuns(runs, { workflowName: 'Northstar canary' }), null);
});
