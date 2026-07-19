'use strict';
// Substrate conformance (spec §4): validate that a claim/signal record matches
// the published JSON Schemas AND satisfies the six mandatory substrate
// properties. Zero-dep: a focused structural validator (not a full Draft-2020-12
// engine) whose required-key checks are kept in sync with the schema files by a
// unit test.
const fs = require('node:fs');
const path = require('node:path');
const { labelFor, summarize } = require('./substrate');

const SCHEMA_DIR = path.join(__dirname, '..', 'schema', 'substrate');

function loadSchema(kind) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, `${kind}.schema.json`), 'utf8'));
}

function isTimestamp(v) {
  return typeof v === 'string' && Number.isFinite(Date.parse(v));
}
function hasActor(a) {
  return a && typeof a === 'object' && typeof a.role === 'string' && a.role.length > 0 &&
    typeof a.runId === 'string' && a.runId.length > 0;
}

// Structural validation against the schema's required keys + core type rules.
function validateShape(record) {
  const errors = [];
  if (!record || typeof record !== 'object') return { ok: false, errors: ['not an object'] };
  const kind = record.kind;
  if (kind !== 'claim' && kind !== 'signal') return { ok: false, errors: [`unknown kind: ${kind}`] };
  const schema = loadSchema(kind);
  for (const key of schema.required) {
    if (record[key] === undefined || record[key] === null) {
      if (!(kind === 'signal' && key === 'zone')) errors.push(`missing: ${key}`);
    }
  }
  if (!hasActor(record.actor)) errors.push('actor.role/runId required');
  if (!(typeof record.ttlSeconds === 'number' && record.ttlSeconds > 0)) errors.push('ttlSeconds must be > 0');
  if (!isTimestamp(record.createdAt)) errors.push('createdAt must be a timestamp');
  if (kind === 'claim') {
    if (!isTimestamp(record.renewedAt)) errors.push('renewedAt must be a timestamp');
    if (!(typeof record.zone === 'string' && record.zone.length)) errors.push('zone required');
    if (!['active', 'released', 'reclaimed'].includes(record.status)) errors.push('bad status');
  } else if (!(typeof record.type === 'string' && record.type.length)) {
    errors.push('type required');
  }
  return { ok: errors.length === 0, errors };
}

// The six mandatory substrate properties, each checked concretely.
function checkProperties(record) {
  const label = (() => {
    try {
      return labelFor(record);
    } catch {
      return '';
    }
  })();
  const readout = (() => {
    try {
      return summarize(record);
    } catch {
      return '';
    }
  })();
  return {
    mortality: typeof record.ttlSeconds === 'number' && record.ttlSeconds > 0 && isTimestamp(record.createdAt),
    actorIdentity: hasActor(record.actor),
    zoneAddressing: record.kind === 'claim' ? !!record.zone : typeof record.type === 'string' && record.type.length > 0,
    inspectability: typeof label === 'string' && label.startsWith('ns:'),
    // override: the marker lives in the human-removable `ns:` label namespace and
    // the record's status is mutable — an operator can always release/expire it.
    override: typeof label === 'string' && label.startsWith('ns:'),
    readout: typeof readout === 'string' && readout.length > 0,
  };
}

function conforms(record) {
  const shape = validateShape(record);
  const props = checkProperties(record);
  const missing = Object.entries(props).filter(([, v]) => !v).map(([k]) => k);
  return { ok: shape.ok && missing.length === 0, shape, properties: props, missing };
}

module.exports = { validateShape, checkProperties, conforms, loadSchema, SCHEMA_DIR };
