'use strict';
// Spec §7.3 — the diff-guard. PURE, no I/O.
//
// Northstar's central promise is that the fix-agent makes tests pass by fixing the
// SOURCE, never by weakening the tests. Until now that was enforced by a sentence in
// a prompt:
//
//     "Do NOT weaken, skip, delete, or edit the tests to make them pass."
//
// Every other rule in the system is a hard gate; this one was a request. A model that
// ignores it produces a green suite and a PR that looks exactly like a real fix. This
// module turns the request into a gate by inspecting the agent's own diff.
//
// It is deliberately NARROW. It rejects only what is unambiguously test-weakening,
// because a false positive blocks a legitimate fix and erodes trust in the guard. A
// human authoring the same change by hand is unaffected — the guard runs on the
// agent's commit only.

// A path is a test file if it sits in a test/spec directory or carries a test suffix.
// Covers the js-ts and python adapter conventions plus the e2e/regression layout.
const TEST_PATH = /(^|\/)(tests?|spec|specs|e2e|__tests__)(\/|$)|(^|\/)test_[^/]+\.py$|\.(test|spec)\.[cm]?[jt]sx?$|_test\.py$/;

function isTestPath(p) {
  return TEST_PATH.test(String(p || ''));
}

// Skip/only markers across the runners Northstar supports.
const SKIP_ADDED = [
  /^\+.*\b(it|test|describe|context)\s*\.\s*(skip|todo)\s*\(/,      // jest/vitest/mocha
  /^\+.*\bxit\s*\(|^\+.*\bxdescribe\s*\(/,                          // legacy x-prefix
  /^\+.*\b(pytest\s*\.\s*mark\s*\.\s*(skip|skipif|xfail))/,         // pytest
  /^\+.*@unittest\s*\.\s*skip/,                                      // unittest
  /^\+.*\bt\s*\.\s*skip\s*\(/,                                       // node:test
  /^\+.*,\s*\{\s*skip:\s*true/,                                      // node:test options
];

/**
 * @param {Array<{path:string, status:string, added:string[], removed:string[]}>} files
 *   One entry per changed file. `added`/`removed` are the +/- lines of its patch.
 * @returns {{ok:boolean, violations:Array<{path:string,kind:string,detail:string}>}}
 */
function inspectDiff(files) {
  const violations = [];
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || !isTestPath(f.path)) continue;
    const added = Array.isArray(f.added) ? f.added : [];
    const removed = Array.isArray(f.removed) ? f.removed : [];

    // 1. Deleting a test file outright.
    if (String(f.status).toLowerCase() === 'deleted') {
      violations.push({ path: f.path, kind: 'test-deleted', detail: 'test file deleted' });
      continue;
    }

    // 2. Adding a skip/todo marker. Removing one is fine — that RE-ENABLES a test.
    for (const re of SKIP_ADDED) {
      const hit = added.find((l) => re.test(l));
      if (hit) {
        violations.push({ path: f.path, kind: 'test-skipped', detail: hit.trim().slice(0, 120) });
        break;
      }
    }

    // 3. Net removal of assertions. Counting rather than pattern-matching individual
    //    edits keeps this robust to reformatting: a refactor that moves assertions
    //    around nets zero, while deleting the inconvenient ones nets negative.
    //
    //    Count OCCURRENCES, not lines. Counting lines missed the most obvious cheat
    //    there is — a one-line test with two assertions, one deleted: both the old
    //    and new line "contain an assertion", so it netted zero and passed. Found by
    //    running the guard against a real git diff rather than only unit fixtures.
    const ASSERT = /\b(assert|expect|should)\b|\bt\.(equal|deepEqual|ok|match|throws)\b/g;
    const count = (lines) => lines.reduce((n, l) => n + (String(l).match(ASSERT) || []).length, 0);
    const addedAsserts = count(added);
    const removedAsserts = count(removed);
    if (removedAsserts > addedAsserts) {
      violations.push({
        path: f.path,
        kind: 'assertions-removed',
        detail: `${removedAsserts} assertion line(s) removed, ${addedAsserts} added`,
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

function formatViolations(violations) {
  return (violations || [])
    .map((v) => `  ${v.path}: ${v.kind} — ${v.detail}`)
    .join('\n');
}

module.exports = { inspectDiff, isTestPath, formatViolations };
