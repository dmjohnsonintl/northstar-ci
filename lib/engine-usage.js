'use strict';
// Parse the `claude -p --output-format json` result envelope into the usage blob
// Northstar records. Pure + defensive: any missing/malformed field yields null
// (cost is observability — never fabricate it).

function num(v) {
  // Only accept real numbers — never coerce arrays/booleans/whitespace strings
  // into a fabricated cost (Number([5])===5, Number(true)===1, Number('  ')===0).
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseClaudeUsage(envelope) {
  let o;
  try {
    o = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
  } catch {
    o = null;
  }
  o = o && typeof o === 'object' ? o : {};
  const u = o.usage && typeof o.usage === 'object' ? o.usage : {};
  const tokenObj = {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
  };
  const anyTok = tokenObj.input !== null || tokenObj.output !== null || tokenObj.cacheRead !== null;
  return {
    engine: 'claude-code',
    costUsd: num(o.total_cost_usd),
    tokens: anyTok ? tokenObj : null,
    model: typeof o.model === 'string' ? o.model : null,
    numTurns: num(o.num_turns),
  };
}

module.exports = { parseClaudeUsage };

// CLI: read the envelope from stdin, write the blob JSON to stdout.
if (require.main === module) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => process.stdout.write(JSON.stringify(parseClaudeUsage(chunks.join('')))));
}
