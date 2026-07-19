#!/usr/bin/env node
'use strict';
// Thin CLI over lib/substrate + lib/conformance so the actions/GC workflow stay
// shell-thin. Subcommands:
//   sweep       --records r.json --now ISO [--stale-after N] [--starvation N]
//   validate    --record c.json                (exit 1 if it doesn't conform)
//   new-claim   --zone Z --role R --run-id ID --ttl N --now ISO
//   new-signal  --type T [--zone Z] --role R --run-id ID --ttl N --now ISO
const fs = require('node:fs');
const S = require('./substrate');
const { conforms } = require('./conformance');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}
function requireNow() {
  const now = arg('now');
  if (!now) {
    console.error('substrate-cli: --now <ISO|ms> is required');
    process.exit(2);
  }
  return now;
}

const cmd = process.argv[2];

if (cmd === 'sweep') {
  const records = readJson(arg('records'), []);
  const decisions = S.sweep(records, {
    now: requireNow(),
    staleAfterSeconds: arg('stale-after') ? Number(arg('stale-after')) : undefined,
    starvationThresholdSeconds: arg('starvation') ? Number(arg('starvation')) : undefined,
  });
  process.stdout.write(JSON.stringify(decisions));
} else if (cmd === 'validate') {
  const record = readJson(arg('record'), null);
  const r = conforms(record);
  process.stdout.write(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
} else if (cmd === 'new-claim') {
  const c = S.newClaim({
    zone: arg('zone'),
    role: arg('role', 'fixer'),
    runId: arg('run-id', 'local'),
    ttlSeconds: arg('ttl') ? Number(arg('ttl')) : undefined,
    now: requireNow(),
  });
  process.stdout.write(JSON.stringify(c));
} else if (cmd === 'new-signal') {
  const s = S.newSignal({
    type: arg('type'),
    zone: arg('zone'),
    role: arg('role', 'system'),
    runId: arg('run-id', 'local'),
    ttlSeconds: arg('ttl') ? Number(arg('ttl')) : undefined,
    now: requireNow(),
  });
  process.stdout.write(JSON.stringify(s));
} else {
  console.error(`substrate-cli: unknown command '${cmd || ''}' (sweep|validate|new-claim|new-signal)`);
  process.exit(2);
}
