'use strict';
// Observability read-model (spec §12). A PURE aggregation over traces the
// pipeline already emits — GitHub Actions run history, the coverage-baseline
// file's git history, Northstar PRs, and ns:* labeled issues. No stored state,
// no secrets, no new primitives; the dashboard lives in the client's own repo.
//
// Everything here is deterministic: callers pass `now` in (never Date.now()), so
// the same inputs always render the same Markdown — which is what makes it
// unit-testable and safe in the workflow runtime.

const DAY_MS = 24 * 60 * 60 * 1000;

function toMs(t) {
  if (t == null) return NaN;
  if (typeof t === 'number') return t;
  return Date.parse(t);
}

function pct(n, d) {
  if (!d) return null;
  return Math.round((n / d) * 1000) / 10; // one decimal
}

function fmtPct(v) {
  return v == null ? '—' : `${v}%`;
}

function fmtDelta(v) {
  if (v == null) return '—';
  if (v === 0) return '±0';
  return `${v > 0 ? '▲ +' : '▼ '}${v}`;
}

// Normalize `gh run list --json databaseId,workflowName,conclusion,status,event,createdAt,updatedAt,url`
// objects into the internal record shape.
function fromGhRuns(runs) {
  return (runs || []).map((r) => {
    const created = r.createdAt || r.created_at || null;
    const updated = r.updatedAt || r.updated_at || null;
    const cms = toMs(created);
    const ums = toMs(updated);
    const conclusion = (r.conclusion || '').toLowerCase();
    const result = conclusion === 'success' ? 'passed' : conclusion === 'failure' ? 'failed' : conclusion ? 'other' : 'pending';
    return {
      id: r.databaseId != null ? r.databaseId : r.id,
      workflow: r.workflowName || r.workflow || r.name || 'unknown',
      trigger: r.event || 'unknown',
      status: (r.status || '').toLowerCase() || 'unknown',
      result,
      createdAt: created,
      updatedAt: updated,
      durationMs: Number.isFinite(cms) && Number.isFinite(ums) && ums >= cms ? ums - cms : null,
    };
  });
}

function median(nums) {
  const xs = nums.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

// Build the pipeline-health read model over a time window ending at `now`.
//   records    — from fromGhRuns()
//   now        — window end (ISO string or ms); REQUIRED, never Date.now()
//   sinceDays  — window width (default 7)
function rollup(records, opts = {}) {
  const now = toMs(opts.now);
  if (!Number.isFinite(now)) throw new Error('rollup: `now` is required (ISO string or ms)');
  const sinceDays = opts.sinceDays || 7;
  const from = now - sinceDays * DAY_MS;

  const inWindow = (records || []).filter((r) => {
    const t = toMs(r.createdAt);
    return Number.isFinite(t) && t >= from && t <= now;
  });
  const completed = inWindow.filter((r) => r.result === 'passed' || r.result === 'failed');
  const passed = completed.filter((r) => r.result === 'passed').length;
  const failed = completed.filter((r) => r.result === 'failed').length;

  const byWorkflow = {};
  for (const r of inWindow) {
    const w = (byWorkflow[r.workflow] = byWorkflow[r.workflow] || { total: 0, passed: 0, failed: 0 });
    w.total += 1;
    if (r.result === 'passed') w.passed += 1;
    else if (r.result === 'failed') w.failed += 1;
  }

  return {
    window: { sinceDays, fromISO: new Date(from).toISOString(), toISO: new Date(now).toISOString() },
    pipeline: {
      total: inWindow.length,
      completed: completed.length,
      passed,
      failed,
      passRate: pct(passed, passed + failed),
      medianDurationMs: median(completed.map((r) => r.durationMs)),
      byWorkflow,
    },
  };
}

// Coverage trend from the baseline file's git history: [{date, linePct}], any order.
function coverageSeries(history) {
  const series = (history || [])
    .filter((h) => Number.isFinite(Number(h.linePct)))
    .map((h) => ({ date: h.date || null, linePct: Number(h.linePct) }))
    .sort((a, b) => toMs(a.date) - toMs(b.date));
  if (!series.length) return { series: [], latest: null, first: null, deltaFromFirst: null, deltaFromPrev: null };
  const latest = series[series.length - 1].linePct;
  const first = series[0].linePct;
  const prev = series.length > 1 ? series[series.length - 2].linePct : first;
  const round1 = (x) => Math.round(x * 10) / 10;
  return {
    series,
    latest: round1(latest),
    first: round1(first),
    deltaFromFirst: round1(latest - first),
    deltaFromPrev: round1(latest - prev),
  };
}

// Agent/model-health view (spec §12.1). `events` are counts gathered from GitHub
// traces (Northstar PRs opened/merged/closed, ns:needs-human / ns:needs-info
// labeled issues). Absent fields render as "—" — never a fabricated zero.
function agentHealth(events = {}) {
  const opened = events.fixPrsOpened;
  const escalations = events.escalations;
  const merged = events.fixPrsMerged;
  const closed = events.fixPrsClosedUnmerged;
  const successRate =
    opened != null && escalations != null ? pct(opened, opened + escalations) : null;
  const acceptanceRate =
    merged != null && closed != null ? pct(merged, merged + closed) : null;
  return {
    fixPrsOpened: opened ?? null,
    escalations: escalations ?? null,
    reproduced: events.reproduced ?? null,
    needsInfo: events.needsInfo ?? null,
    promoted: events.promoted ?? null,
    fixSuccessRate: successRate,
    humanAcceptanceRate: acceptanceRate,
    canary: events.canary || null, // 'green' | 'red' | null
  };
}

function barFor(passRate) {
  if (passRate == null) return '';
  const filled = Math.round(passRate / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

// ---- Renderers ----

function renderDashboard(model) {
  const { rollup: rl, coverage = {}, agent = {}, generatedAt, repo } = model;
  const p = rl.pipeline;
  const lines = [];
  lines.push(`# Northstar status${repo ? ` — ${repo}` : ''}`);
  lines.push('');
  lines.push(`_Window: last ${rl.window.sinceDays} days · generated ${generatedAt || rl.window.toISO}_`);
  lines.push('');

  lines.push('## Pipeline health');
  lines.push('');
  lines.push(`- **Runs:** ${p.total} (${p.completed} completed)`);
  lines.push(`- **Green rate:** ${fmtPct(p.passRate)} ${barFor(p.passRate)} (${p.passed} passed / ${p.failed} failed)`);
  if (p.medianDurationMs != null) lines.push(`- **Median run time:** ${Math.round(p.medianDurationMs / 1000)}s`);
  lines.push('');
  const wf = Object.keys(p.byWorkflow).sort();
  if (wf.length) {
    lines.push('| Workflow | Runs | Passed | Failed |');
    lines.push('|---|--:|--:|--:|');
    for (const w of wf) {
      const b = p.byWorkflow[w];
      lines.push(`| ${w} | ${b.total} | ${b.passed} | ${b.failed} |`);
    }
    lines.push('');
  }

  lines.push('## Coverage trend');
  lines.push('');
  if (coverage.latest == null) {
    lines.push('_No coverage baseline history yet._');
  } else {
    lines.push(`- **Latest:** ${fmtPct(coverage.latest)} (Δ vs previous ${fmtDelta(coverage.deltaFromPrev)}, vs window start ${fmtDelta(coverage.deltaFromFirst)})`);
    const pts = coverage.series.slice(-8);
    lines.push(`- **Recent:** ${pts.map((x) => `${x.linePct}%`).join(' → ')}`);
  }
  lines.push('');

  lines.push('## Agent / model health');
  lines.push('');
  lines.push(`- **Fix success rate:** ${fmtPct(agent.fixSuccessRate)} (${agent.fixPrsOpened ?? '—'} fixed → PR, ${agent.escalations ?? '—'} escalated to \`ns:needs-human\`)`);
  lines.push(`- **Human acceptance:** ${fmtPct(agent.humanAcceptanceRate)}`);
  lines.push(`- **Bugs reproduced:** ${agent.reproduced ?? '—'} (\`ns:needs-info\`: ${agent.needsInfo ?? '—'})`);
  lines.push(`- **Tests promoted to regression:** ${agent.promoted ?? '—'}`);
  if (agent.canary) lines.push(`- **Nightly canary:** ${agent.canary === 'green' ? '🟢 green' : '🔴 RED — model may have regressed'}`);
  lines.push('');

  lines.push('## Not yet wired');
  lines.push('');
  lines.push('- **Cost (tokens / CI minutes)** and **coordination health (claims/flake)** require the per-run metrics-record stream (Tier 1 append log) — not yet emitted, so shown as `—` above rather than a fabricated zero.');
  lines.push('');
  return lines.join('\n');
}

function renderDigest(model) {
  const { rollup: rl, coverage = {}, agent = {} } = model;
  const p = rl.pipeline;
  const cov =
    coverage.latest == null
      ? 'coverage n/a'
      : `coverage ${coverage.first}%→${coverage.latest}% (${fmtDelta(coverage.deltaFromFirst)})`;
  const parts = [
    `${p.total} runs`,
    `${fmtPct(p.passRate)} green`,
    cov,
    `${agent.fixPrsOpened ?? 0} auto-fixed`,
    `${agent.escalations ?? 0} escalated`,
    `${agent.promoted ?? 0} promoted`,
  ];
  return `Northstar (last ${rl.window.sinceDays}d): ${parts.join(', ')}.`;
}

module.exports = {
  fromGhRuns,
  rollup,
  coverageSeries,
  agentHealth,
  renderDashboard,
  renderDigest,
};
