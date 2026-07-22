#!/usr/bin/env node
'use strict';
// Evaluate §12.1 alerts from gathered traces and print the decisions as JSON.
//
//   node lib/alerts-cli.js \
//     --runs runs.json --coverage coverage.json --agent agent.json --claims claims.json \
//     --now 2026-07-22T00:00:00Z \
//     --escalation-rate 0.5 --coverage-delta-min 0 --claim-age-seconds 21600 \
//     --canary-workflow 'Northstar canary'
//
// Prints a JSON array to stdout. Zero deps.
const fs = require('node:fs');
const { canaryFromRuns, coverageSeries, agentHealth } = require('./metrics');
const { evaluateAlerts } = require('./alerts');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function readJson(path, fallback) {
  if (!path) return fallback;
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return fallback; }
}

const now = arg('now');
if (!now) { console.error('alerts-cli: --now <ISO> is required'); process.exit(2); }

const runs = readJson(arg('runs'), []);
const coverageHistory = readJson(arg('coverage'), []);
const agentEvents = readJson(arg('agent'), {});
const claims = readJson(arg('claims'), []);
const thresholds = {
  escalationRate: Number(arg('escalation-rate', '0.5')),
  coverageDeltaMin: Number(arg('coverage-delta-min', '0')),
  claimAgeSeconds: Number(arg('claim-age-seconds', '21600')),
};
const canaryWorkflow = arg('canary-workflow', 'Northstar canary');

const health = agentHealth(agentEvents);
const cov = coverageSeries(coverageHistory);
const model = {
  canary: canaryFromRuns(runs, { workflowName: canaryWorkflow }),
  escalation: { opened: health.fixPrsOpened, escalations: health.escalations },
  coverageDeltaFromPrev: cov.deltaFromPrev,
  claims: Array.isArray(claims) ? claims : [],
};

process.stdout.write(JSON.stringify(evaluateAlerts(model, thresholds, { now }), null, 2) + '\n');
