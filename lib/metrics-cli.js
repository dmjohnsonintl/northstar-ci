#!/usr/bin/env node
'use strict';
// Render the Northstar observability read-model to Markdown.
//
//   node lib/metrics-cli.js \
//     --runs runs.json \            # `gh run list --json ...` output
//     --coverage coverage.json \    # [{date, linePct}] from the baseline git history (optional)
//     --agent agent.json \          # { fixPrsOpened, escalations, reproduced, needsInfo, promoted, ... } (optional)
//     --now 2026-07-18T00:00:00Z \  # window end (required; keeps output deterministic)
//     --since 7 --repo owner/name --mode dashboard|digest
//
// Prints Markdown (dashboard) or a one-line digest to stdout. Zero deps.
const fs = require('node:fs');
const {
  fromGhRuns,
  rollup,
  coverageSeries,
  agentHealth,
  renderDashboard,
  renderDigest,
} = require('./metrics');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function readJson(path, fallback) {
  if (!path) return fallback;
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

const now = arg('now');
if (!now) {
  console.error('metrics-cli: --now <ISO|ms> is required');
  process.exit(2);
}
const runs = readJson(arg('runs'), []);
const coverageHistory = readJson(arg('coverage'), []);
const agentEvents = readJson(arg('agent'), {});
// { activeClaims, signals:{flaky,coverageGap,reclaimed}, promotions } from repo traces
const extra = readJson(arg('extra'), {});
const sinceDays = Number(arg('since', '7')) || 7;
const repo = arg('repo');
const mode = arg('mode', 'dashboard');

const sig = extra.signals || {};
const model = {
  rollup: rollup(fromGhRuns(runs), { now, sinceDays }),
  coverage: coverageSeries(coverageHistory),
  agent: agentHealth(agentEvents),
  coordination: {
    activeClaims: extra.activeClaims,
    flakySignals: sig.flaky,
    coverageGapSignals: sig.coverageGap,
    reclaimedSignals: sig.reclaimed,
  },
  regression: { promotions: extra.promotions },
  generatedAt: now,
  repo,
};

process.stdout.write((mode === 'digest' ? renderDigest(model) : renderDashboard(model)) + '\n');
