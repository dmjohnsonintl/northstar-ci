'use strict';
// Adapter conformance suite (spec §9, layer 2): the SAME contract, asserted
// against every adapter. Add a new adapter to the ADAPTERS list below plus a
// pair of fixtures under _contract-fixtures/<name>/ and it's covered — "pass the
// contract = done."
const { defineAdapterContract, pythonToolchainAvailable } = require('./contract');

const ADAPTERS = [
  {
    name: 'js-ts',
    dir: 'js-ts',
    available: () => true, // node + bash are always present where this suite runs
    testCmd: 'node --test', // discovers the fixture's single *.test.js
    // coverage.sh is a thin locate-and-report step; the coverage TOOL is
    // consumer-supplied, so the fixture's cov command just stages a real
    // Istanbul summary. This tests the adapter, not Jest/c8.
    covFixture: 'cov',
    covCmd: 'mkdir -p coverage && cp _summary.json coverage/coverage-summary.json',
  },
  {
    name: 'python',
    dir: 'python',
    available: pythonToolchainAvailable, // skipped locally without pytest+coverage; real in CI
    testCmd: 'python3 -m pytest -q',
    // Exercises the REAL coverage.py -> lib/coverage-normalize path end to end.
    covFixture: 'pass',
    covCmd: 'coverage run -m pytest -q && coverage json -o coverage.json',
  },
];

for (const adapter of ADAPTERS) {
  defineAdapterContract(adapter);
}
