# Publishing the Northstar package

Consumers install Northstar by calling the reusable workflow at a tag:

```yaml
uses: dmjohnsonintl/northstar-ci/.github/workflows/northstar-pipeline.yml@v0
```

so the package must live on GitHub with a `v0` tag pointing at a green `main`.

## Re-releasing v0

`v0` is a **moving** tag. After merging work to `main`:

```bash
git push origin main
git tag -f v0            # move the tag to the new commit
git push -f origin v0    # publish the moved tag
```

Verify there is no drift between what consumers get and what `main` has:

```bash
git fetch origin --tags
[ "$(git rev-parse origin/main)" = "$(git rev-parse v0)" ] && echo "v0 == main" || echo "DRIFT"
```

> **Note.** The metrics workflow commits `docs/northstar-status.md` to `main` on a
> schedule (`chore(metrics): refresh northstar-status dashboard [skip ci]`), so
> `main` routinely runs ahead of `v0` by doc-only commits. That is expected and
> harmless — only re-tag when *code* changes.

## Gotcha — auth for pushing

Two things bit us on the first publish and can recur on a fresh machine:

1. **SSH vs HTTPS.** `gh repo create --source=.` wires `origin` as SSH
   (`git@github.com:...`); if the machine's SSH key isn't authorized you get
   `Permission denied (publickey)`. Fix — use HTTPS + the gh credential helper:
   ```bash
   git remote set-url origin https://github.com/dmjohnsonintl/northstar-ci.git
   gh auth setup-git
   ```
2. **Missing `workflow` scope.** Pushing anything under `.github/workflows/`
   requires the token to have the `workflow` scope, or GitHub rejects it:
   *"refusing to allow an OAuth App to create or update workflow ... without
   `workflow` scope."* Grant it once (interactive):
   ```bash
   gh auth refresh -h github.com -s workflow
   ```

## Why this repo is public

Northstar started as the **private** `dmjohnsonintl/Northstar` repo (now archived).
Private distribution turned out to cost more than it bought:

- A private reusable workflow is only callable by same-owner repos, and only
  after *Settings → Actions → General → Access* is explicitly widened.
- Composite actions inside a private package can't be referenced by a local `./`
  path from a consuming repo — they have to be addressed by full
  `owner/repo/path@ref`, which is what commit `e250235` in the old repo fixed.

Republishing publicly removes both constraints. The code is public; the license
(`SECURITY.md`, `README.md`) still reserves all rights.

## Consumer-side prerequisites

Documented in [`adoption-v0.md`](adoption-v0.md) — token permissions, the
"Allow GitHub Actions to create and approve pull requests" setting, and
`ANTHROPIC_API_KEY` when `engine: 'claude-code'`.
