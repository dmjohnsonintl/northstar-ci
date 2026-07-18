'use strict';

function matchSegs(file, pat) {
  if (pat.length === 0) return file.length === 0;
  const [head, ...rest] = pat;
  if (head === '**') {
    for (let i = 0; i <= file.length; i++) {
      if (matchSegs(file.slice(i), rest)) return true;
    }
    return false;
  }
  if (file.length === 0) return false;
  if (head === '*' || head === file[0]) return matchSegs(file.slice(1), rest);
  return false;
}

function matchGlob(filePath, glob) {
  const fileSegs = filePath.split('/').filter(Boolean);
  const globSegs = glob.split('/').filter(Boolean);
  return matchSegs(fileSegs, globSegs);
}

function specificity(glob) {
  return glob.split('/').filter((s) => s && s !== '*' && s !== '**').length;
}

function resolveZones(changedFiles, zoneDefs) {
  const zones = new Set();
  for (const file of changedFiles) {
    let best = null;
    let bestScore = -1;
    for (const def of zoneDefs) {
      if (matchGlob(file, def.glob) && specificity(def.glob) > bestScore) {
        bestScore = specificity(def.glob);
        best = def.zone;
      }
    }
    if (best) zones.add(best);
  }
  return [...zones].sort();
}

module.exports = { matchGlob, resolveZones };
