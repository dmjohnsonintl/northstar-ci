'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseClaudeUsage } = require('./engine-usage');

// A captured `claude -p --output-format json` success envelope (shape only; no CLI).
const ENVELOPE = JSON.stringify({
  type: 'result', subtype: 'success',
  total_cost_usd: 0.0123,
  usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 8000 },
  model: 'claude-opus-4-8', num_turns: 3, result: 'done',
});

test('parseClaudeUsage extracts cost, tokens, model, turns', () => {
  const u = parseClaudeUsage(ENVELOPE);
  assert.equal(u.engine, 'claude-code');
  assert.equal(u.costUsd, 0.0123);
  assert.deepEqual(u.tokens, { input: 1200, output: 340, cacheRead: 8000 });
  assert.equal(u.model, 'claude-opus-4-8');
  assert.equal(u.numTurns, 3);
});

test('parseClaudeUsage returns nulls for malformed/empty input (never fabricates cost)', () => {
  for (const bad of ['', 'not json', '{}', JSON.stringify({ result: 'x' })]) {
    const u = parseClaudeUsage(bad);
    assert.equal(u.engine, 'claude-code');
    assert.equal(u.costUsd, null);
    assert.equal(u.tokens, null);
    assert.equal(u.model, null);
    assert.equal(u.numTurns, null);
  }
});

test('parseClaudeUsage keeps partial tokens when some fields present', () => {
  const u = parseClaudeUsage(JSON.stringify({ total_cost_usd: 1, usage: { input_tokens: 5 } }));
  assert.equal(u.costUsd, 1);
  assert.deepEqual(u.tokens, { input: 5, output: null, cacheRead: null });
});

test('parseClaudeUsage never fabricates cost from coercible non-numbers', () => {
  for (const bad of [[], [5], true, '  ', {}]) {
    const u = parseClaudeUsage(JSON.stringify({ total_cost_usd: bad, usage: { input_tokens: bad } }));
    assert.equal(u.costUsd, null);
    assert.equal(u.tokens, null);
  }
});
