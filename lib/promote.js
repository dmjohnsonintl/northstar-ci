'use strict';
const path = require('path');

function selectPromotions(stagedFiles, passedFiles, { stagingDir, regressionDir }) {
  const passed = passedFiles instanceof Set ? passedFiles : new Set(passedFiles);
  const moves = [];
  for (const from of stagedFiles) {
    if (!passed.has(from)) continue;
    const rel = path.relative(stagingDir, from);
    moves.push({ from, to: path.join(regressionDir, rel) });
  }
  return moves;
}

module.exports = { selectPromotions };
