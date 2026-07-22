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

  return out;
}

module.exports = { evaluateAlerts, titleFor };
