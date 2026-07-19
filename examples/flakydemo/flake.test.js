'use strict';
// A deterministically-flaky test: it FAILS on the first run of a job and PASSES
// on the retry. run-suite runs both attempts in the same workdir on the same
// runner, so the marker file persists between attempts (a fresh runner each new
// workflow run re-arms the flake). This exercises retry-once flake detection.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const marker = process.env.NS_FLAKE_MARKER || path.join(os.tmpdir(), 'ns-flake-marker');

test('flaky: fails first, passes on retry', () => {
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, '1');
    assert.fail('simulated flake — first attempt fails');
  }
});
