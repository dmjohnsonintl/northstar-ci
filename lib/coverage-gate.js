'use strict';

function linePct(summary) {
  const pct = summary && summary.total && summary.total.lines && summary.total.lines.pct;
  if (typeof pct !== 'number' || Number.isNaN(pct)) {
    throw new Error('invalid coverage-summary.json: missing total.lines.pct');
  }
  return pct;
}

function evaluateGate({ current, baseline, min, mode }) {
  if (typeof current !== 'number' || Number.isNaN(current)) {
    throw new TypeError('current coverage must be a number');
  }
  if (baseline === null || baseline === undefined) {
    return { pass: true, reason: `baseline established at ${current.toFixed(2)}%`, newBaseline: current };
  }
  if (mode === 'report') {
    return { pass: true, reason: `report-only: ${current.toFixed(2)}%`, newBaseline: Math.max(baseline, current) };
  }
  if (current < min) {
    return { pass: false, reason: `coverage ${current.toFixed(2)}% is below minimum ${min}%`, newBaseline: baseline };
  }
  if (mode === 'no-decrease' && current < baseline) {
    return { pass: false, reason: `coverage dropped ${baseline.toFixed(2)}% → ${current.toFixed(2)}%`, newBaseline: baseline };
  }
  return {
    pass: true,
    reason: `coverage ${current.toFixed(2)}% ≥ baseline ${baseline.toFixed(2)}%`,
    newBaseline: Math.max(baseline, current),
  };
}

module.exports = { linePct, evaluateGate };
