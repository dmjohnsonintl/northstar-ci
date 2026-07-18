# Installing Northstar v0 on a repo

1. Add `.github/workflows/ci.yml`:
   ```yaml
   name: Northstar
   on:
     pull_request:
     push:
       branches: [main, master]
   # REQUIRED: a called reusable workflow cannot exceed the caller's token grant,
   # and Northstar ratchets the coverage baseline + opens fix PRs on the default
   # branch. GitHub's default token is read-only, so grant these explicitly:
   permissions:
     contents: write
     pull-requests: write
   jobs:
     northstar:
       uses: dmjohnsonintl/northstar-ci/.github/workflows/northstar-pipeline.yml@v0
       with:
         workdir: frontend
         zones-json: '[{"zone":"frontend","glob":"frontend/**"}]'
         coverage-min: '80'
         engine: 'stub'          # 'claude-code' to enable the real AI fix-agent
       secrets: inherit          # passes ANTHROPIC_API_KEY through when engine=claude-code
   ```
2. Ensure the project has `test:ci` and `test:coverage` npm scripts, the latter
   emitting `coverage/coverage-summary.json` (json-summary reporter).
3. Commit `.northstar/coverage-baseline.json` (or let the first run on the default
   branch establish it).
4. Create `tests/new/` and `tests/regression/` directories.
5. **For the fix-agent to open PRs:** in the consuming repo, enable
   **Settings → Actions → General → Workflow permissions →
   "Allow GitHub Actions to create and approve pull requests."** Without it, the
   fix is pushed to a branch but the PR must be opened manually (Northstar logs a
   warning to that effect).
6. **For the real AI fix-agent** (`engine: 'claude-code'`): add an
   `ANTHROPIC_API_KEY` secret to the consuming repo. With `engine: 'stub'`
   (default) no key is needed.
