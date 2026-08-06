#!/usr/bin/env node
'use strict';
// Spec §7.3 diff-guard, I/O shell. Reads `git show`-style unified diff text on stdin
// and exits non-zero if the agent weakened tests.
//
//   git show --unified=0 --no-color HEAD | node lib/diff-guard-cli.js
//
// Exit 0 = clean, 1 = violations (printed to stderr). Parsing lives here; the
// decision lives in the pure, unit-tested lib/diff-guard.js.
const { inspectDiff, formatViolations } = require('./diff-guard');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const files = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      // b/ is the post-image path; for a delete git still emits it, and the
      // "deleted file mode" marker below is what actually flags the deletion.
      cur = { path: m[2], status: 'modified', added: [], removed: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('deleted file mode')) { cur.status = 'deleted'; continue; }
    if (line.startsWith('new file mode')) { cur.status = 'added'; continue; }
    // +++/--- are headers, not content. Everything else with a leading +/- is a line.
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) cur.added.push(line);
    else if (line.startsWith('-')) cur.removed.push(line);
  }

  const { ok, violations } = inspectDiff(files);
  if (ok) {
    console.log(`[northstar] diff-guard: clean (${files.length} file(s) inspected)`);
    process.exit(0);
  }
  console.error('::error::Northstar diff-guard REJECTED the agent diff — it weakened tests.');
  console.error(formatViolations(violations));
  console.error('');
  console.error('The fix-agent must make tests pass by fixing SOURCE. Weakening, skipping or');
  console.error('deleting a test defeats the gate it is supposed to satisfy.');
  process.exit(1);
});
