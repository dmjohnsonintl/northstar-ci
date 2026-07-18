# Installing Northstar v0 on a repo

1. Add `.github/workflows/ci.yml`:
   ```yaml
   name: Northstar
   on:
     pull_request:
     push:
       branches: [main, master]
   jobs:
     northstar:
       uses: dmjohnsonintl/northstar-ci/.github/workflows/northstar-pipeline.yml@v0
       with:
         workdir: frontend
         zones-json: '[{"zone":"frontend","glob":"frontend/**"}]'
         coverage-min: '80'
       secrets: inherit
   ```
2. Ensure the project has `test:ci` and `test:coverage` npm scripts, the latter
   emitting `coverage/coverage-summary.json` (json-summary reporter).
3. Commit `.northstar/coverage-baseline.json` (or let the first run on the default
   branch establish it).
4. Create `tests/new/` and `tests/regression/` directories.
