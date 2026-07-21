'use strict';
// Parse the `claude -p --output-format json` result envelope into the usage blob
// Northstar records. Pure + defensive: any missing/malformed field yields null
// (cost is observability — never fabricate it).

function num(v) {
  return Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null;
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
  const anyTok =
    u.input_tokens != null || u.output_tokens != null || u.cache_read_input_tokens != null;
  return {
    engine: 'claude-code',
    costUsd: num(o.total_cost_usd),
    tokens: anyTok
      ? { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens) }
      : null,
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
