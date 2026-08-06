'use strict';
// §12.1 alert rule engine. PURE: `now` is injected, never Date.now(). Each rule
// returns a decision — 'firing' or 'clear' — or is OMITTED when its input is
// missing (an absent signal is not evidence of a problem, mirroring the read-model's
// "null, never a fabricated zero" discipline). The workflow turns decisions into
// deduped issues: firing → open/comment, clear → close an open issue.
const { isStarved } = require('./substrate');

const titleFor = (rule) => `Northstar alert: ${rule}`;

function evaluateAlerts(model = {}, thresholds = {}, { now } = {}) {
  if (now == null) throw new Error('evaluateAlerts: `now` is required');
  const escalationRate = thresholds.escalationRate ?? 0.5;
  const coverageDeltaMin = thresholds.coverageDeltaMin ?? 0;
  const claimAgeSeconds = thresholds.claimAgeSeconds ?? 21600;
  const acceptanceMin = thresholds.acceptanceMin ?? 0.5;
  // Below this many DECIDED PRs the rule is omitted — not enough evidence to judge.
  const acceptanceMinSample = thresholds.acceptanceMinSample ?? 3;
  const adoptionAgeSeconds = thresholds.adoptionAgeSeconds ?? 259200; // 3 days
  const adoptionBehindMax = thresholds.adoptionBehindMax ?? 25;
  const out = [];
  const push = (rule, severity, firing, body) =>
    out.push({ rule, severity, state: firing ? 'firing' : 'clear', title: titleFor(rule), body });

  // 1. Canary (page). null → omit.
  if (model.canary === 'red' || model.canary === 'green') {
    const firing = model.canary === 'red';
    push('canary', 'page', firing,
      firing
        ? 'The nightly canary ran the real engine against the known-broken fixture and did NOT produce a green fix. The model may have regressed — investigate before releasing.'
        : 'Canary is green again: the real engine fixed the known-broken fixture. Resolved.');
  }

  // 2. Escalation rate (trend). No fix activity → no denominator → omit.
  const esc = model.escalation;
  if (esc && (esc.opened != null) && (esc.escalations != null) && (esc.opened + esc.escalations) > 0) {
    const rate = esc.escalations / (esc.opened + esc.escalations);
    const firing = rate > escalationRate;
    push('escalation-rate', 'trend', firing,
      `Fix-agent escalation rate is ${(rate * 100).toFixed(0)}% (${esc.escalations} escalated / ${esc.opened + esc.escalations} attempts), threshold ${(escalationRate * 100).toFixed(0)}%.`);
  }

  // 3. Coverage trend (trend). null → omit.
  if (model.coverageDeltaFromPrev != null) {
    const d = model.coverageDeltaFromPrev;
    const firing = d < coverageDeltaMin;
    push('coverage-trend', 'trend', firing,
      firing
        ? `Coverage moved ${d} pts vs the previous baseline (negative trend on the default branch).`
        : `Coverage delta ${d} pts — not below the ${coverageDeltaMin} threshold. Resolved.`);
  }

  // 4. Claim starvation (trend). Reuses substrate.isStarved. Empty → omit.
  const claims = model.claims;
  if (Array.isArray(claims) && claims.length > 0) {
    const starved = claims.filter((c) => isStarved(c, { now, starvationThresholdSeconds: claimAgeSeconds }));
    const firing = starved.length > 0;
    push('claim-starvation', 'trend', firing,
      firing
        ? `${starved.length} zone claim(s) exceed the ${claimAgeSeconds}s starvation threshold (zones: ${starved.map((c) => c.zone).join(', ')}). An agent may be stuck.`
        : `All ${claims.length} active claim(s) are within the ${claimAgeSeconds}s threshold. Resolved.`);
  }

  // 5. Human acceptance (trend). Spec §12.1 names this signal and the dashboard has
  // rendered it since the metrics slice, but nothing alerted on it — the same blind
  // spot that let two adoptions sit unmerged for twelve days.
  //
  // Reads counts already filtered by metrics.fixPrOutcomes: merges are not
  // double-counted as closures, and the canary's own cleanup is excluded. Null
  // counts (no runs payload → canary unidentifiable) omit the rule rather than
  // report a polluted rate.
  //
  // The sample floor matters more here than for escalation-rate: a single closed PR
  // is a 0% acceptance rate, and firing on n=1 would page on the first fix anyone
  // declines for an ordinary reason.
  const acc = model.acceptance;
  if (acc && acc.merged != null && acc.closedUnmerged != null) {
    const decided = acc.merged + acc.closedUnmerged;
    if (decided >= acceptanceMinSample) {
      const rate = acc.merged / decided;
      const firing = rate < acceptanceMin;
      push('human-acceptance', 'trend', firing,
        firing
          ? `Humans merged ${(rate * 100).toFixed(0)}% of fix-agent PRs (${acc.merged} merged / ${decided} decided), below the ${(acceptanceMin * 100).toFixed(0)}% threshold. The agent is producing PRs people don't take — check fix quality before trusting the fix-success rate.`
          : `Human acceptance is ${(rate * 100).toFixed(0)}% (${acc.merged} merged / ${decided} decided), at or above the ${(acceptanceMin * 100).toFixed(0)}% threshold. Resolved.`);
    }
  }

  // 6. Adoption stalled (trend). OPERATOR-side: answers "is my rollout stuck?", a
  // question about a portfolio of repos, not about the repo this runs in. Opt-in
  // via an explicit list, so a client install never sees it (model.adoptions absent
  // → omitted). See docs/superpowers/specs/2026-08-02-adoption-alerting-design.md.
  //
  // Two firing conditions because the two observed failures degrade differently:
  // a11yplus PR #1 sat 12 days at ZERO commits behind (age only), while
  // council-principis drifted 55 commits behind until it was unsafe to merge.
  // Thresholding either alone misses the other.
  //
  // A sentinel entry ({repo, branch: null}) means "configured, nothing stalled" —
  // without it a merged adoption empties the array, which is omission, and an open
  // issue could never close.
  const adoptions = model.adoptions;
  if (Array.isArray(adoptions) && adoptions.length > 0) {
    const real = adoptions.filter((a) => a && a.branch);
    const stalled = real.filter((a) => {
      const since = Date.parse(a.since);
      const ageOk = Number.isFinite(since) && (Date.parse(now) - since) / 1000 > adoptionAgeSeconds;
      const behindOk = Number.isFinite(a.behindBy) && a.behindBy > adoptionBehindMax;
      return ageOk || behindOk;
    });
    const firing = stalled.length > 0;
    const describe = (a) => {
      const days = Math.floor((Date.parse(now) - Date.parse(a.since)) / 86400000);
      const where = a.pr ? `PR #${a.pr} open ${days}d` : `branch \`${a.branch}\` never proposed, ${days}d since last commit`;
      return `- \`${a.repo}\` — ${where}, ${a.behindBy ?? '?'} commits behind.`;
    };
    push('adoption-stalled', 'trend', firing,
      firing
        ? `${stalled.length} Northstar adoption(s) are not landing (thresholds: ${adoptionAgeSeconds}s old, or >${adoptionBehindMax} commits behind):\n\n${stalled.map(describe).join('\n')}\n\nAn adoption that drifts far enough behind stops being safe to merge — its coverage baseline starts describing a codebase that no longer exists.`
        : `All ${real.length} tracked adoption(s) are within both thresholds. Resolved.`);
  }

  return out;
}

module.exports = { evaluateAlerts, titleFor };
