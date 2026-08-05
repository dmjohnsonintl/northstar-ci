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

## How escalation reaches you

When the single-attempt fix does not make the suite green, Northstar escalates.
Two things are guaranteed with the permissions above and no extra setup:

- **The `fix` job goes red.** A human-needed state is never a green job. This is
  the guarantee — it holds even if every delivery channel below fails.
- **On a PR, you get a comment plus the `ns:needs-human` label**, using
  `pull-requests: write` which you already granted.

`issues: write` is **optional**. Grant it if you also want an `ns:needs-human`
*issue* filed for escalations on default-branch pushes, where there is no PR to
comment on:

```yaml
permissions:
  contents: write
  pull-requests: write
  issues: write        # optional — issue-based escalation when there is no PR
```

> **Why it isn't required.** The pipeline is a reusable workflow, and a reusable
> workflow that declares a permission its caller did not grant fails the entire
> run with `startup_failure` — no jobs, no logs, no diagnostic. So the pipeline
> cannot declare `issues: write` on your behalf without breaking every install
> that hasn't added it. Escalation is therefore built on the permission you
> already grant, and the red job is the backstop.

## Gating more than one zone

Put every zone in **one** caller workflow, one job each. Each job gets its own
concurrency group automatically, because the group includes `workdir`:

```yaml
name: Northstar
on:
  pull_request:
  push:
    branches: [main, master]
permissions:
  contents: write
  pull-requests: write
jobs:
  frontend:
    uses: dmjohnsonintl/northstar-ci/.github/workflows/northstar-pipeline.yml@v0
    with:
      workdir: frontend
      zones-json: '[{"zone":"frontend","glob":"frontend/**"}]'
      coverage-min: '0'
      coverage-mode: 'no-decrease'
    secrets: inherit
  backend:
    uses: dmjohnsonintl/northstar-ci/.github/workflows/northstar-pipeline.yml@v0
    with:
      workdir: backend
      adapter: python
      python-version: '3.11'
      install-cmd: pip install -r requirements.txt
      test-cmd: python -m pytest
      coverage-cmd: coverage run -m pytest && coverage json -o coverage.json
      zones-json: '[{"zone":"backend","glob":"backend/**"}]'
      coverage-min: '0'
      coverage-mode: 'no-decrease'
    secrets: inherit
```

**If two jobs share a `workdir`** (e.g. two zone globs over the same tree), set
`concurrency-key` explicitly so they don't cancel each other:

```yaml
  api:
    uses: dmjohnsonintl/northstar-ci/.github/workflows/northstar-pipeline.yml@v0
    with:
      workdir: .
      concurrency-key: api        # <- distinct per job
      zones-json: '[{"zone":"api","glob":"api/**"}]'
```

> **Why.** Inside a reusable workflow `github.workflow` resolves to the *caller's*
> name, so it is identical for every job in one caller. Before `concurrency-key`
> existed, all zones landed in the same group and `cancel-in-progress` made the
> second job **cancel** the first — a zone would vanish with no failure to point
> at (issue #12). Splitting into one workflow file per zone was the old
> workaround; it is no longer necessary.
