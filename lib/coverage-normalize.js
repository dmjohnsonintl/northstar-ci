'use strict';

// Convert a coverage.py `coverage json` object into the Istanbul json-summary
// shape that lib/coverage-gate.js reads. coverage.py measures statements; its
// `totals.percent_covered` is the canonical Python coverage metric, which we map
// to the gate's line-coverage percentage.
function fromPytestCov(cov) {
  const t = cov && cov.totals;
  if (!t || typeof t.percent_covered !== 'number' || Number.isNaN(t.percent_covered)) {
    throw new Error('invalid coverage.py json: missing totals.percent_covered');
  }
  return {
    total: {
      lines: {
        total: typeof t.num_statements === 'number' ? t.num_statements : 0,
        covered: typeof t.covered_lines === 'number' ? t.covered_lines : 0,
        skipped: 0,
        pct: t.percent_covered,
      },
    },
  };
}

module.exports = { fromPytestCov };
