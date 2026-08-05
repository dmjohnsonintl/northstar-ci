# Security

Northstar is a **public, others-consumable** GitHub Actions package. It is designed
to be safe to run inside another repo's CI, and safe to have its source public.

## What this package does NOT contain
- **No secrets, tokens, or API keys.** Nothing in this repo or its git history is a
  credential. The one credential Northstar can use — an `ANTHROPIC_API_KEY` for the
  `claude-code` fix-agent engine — is supplied by the **consuming** repo via its own
  encrypted secrets, reaches the engine only through `env:`, and is never stored here.
  With the default `stub` engine no key exists at all.

## Design choices that keep consumers safe
- **`pull_request`, never `pull_request_target`.** Untrusted pull-request code is
  never executed with a write-scoped token or with the consumer's secrets. (The
  `pull_request_target` pattern is the classic source of Actions compromise; we do
  not use it.)
- **Injection-safe shell.** Any GitHub-context value used in a `run:` step is passed
  through `env:` and referenced as `"$VAR"` — never interpolated as
  `${{ ... }}` directly into a command. This blocks command-injection via
  attacker-controlled fields (branch names, and later, issue/PR text).
- **Least-privilege token.** The reusable workflow requests only `contents: write`
  (to ratchet the coverage baseline and promote regression tests on the default
  branch) and `pull-requests: write`. Consumers can further restrict via their caller
  workflow's `permissions:`.

  > This set is **load-bearing and must not be widened**. A reusable workflow that
  > declares a permission its caller did not grant does not degrade gracefully — the
  > entire run ends in `startup_failure` with no jobs, no logs and no diagnostic
  > (verified directly, 2026-08-05). Because `v0` is a moving tag, adding a scope
  > here silently breaks every consumer that has not updated their caller first.
  > Escalation was deliberately built on `pull-requests: write` for this reason
  > rather than requiring `issues: write`.
- **No dynamic `ref:` checkouts** of untrusted input.
- **Pinned actions.** Third-party steps use first-party GitHub actions
  (`actions/checkout`, `actions/setup-node`) at major-version tags. SHA-pinning is on
  the roadmap for stricter supply-chain guarantees.

## Secret-scan is a hard block (no agent)
The pipeline runs **gitleaks** first (config-toggle `secret-scan`, on by default). A
finding **fails the run before the test suite executes** and **no fix-agent is
invoked** — a leaked credential is a human/security matter, not something to
auto-"fix." Because the fix job keys off a *test-suite* failure and the suite step
never runs when the scan blocks, an agent can never touch a repo that just leaked.

## Bug-intake & untrusted issue text
The bug-intake door reads **attacker-controlled** issue titles/bodies. Two protections:
- **No command injection.** Issue text reaches a shell only through `env:` vars
  (never interpolated into a `run:` command), so it can't inject shell commands.
- **Prompt-injection is contained by human review.** A malicious issue could try to
  steer the AI reproduce/fix engine. The engine runs on an **ephemeral runner** with a
  workflow-scoped token, and its only output is a **pull request that never
  auto-merges** — a human reviews every change before it lands. Do not enable
  auto-merge for Northstar branches.

## Reporting a vulnerability
Open a private security advisory on this repository, or contact the owner directly.
Please do not file public issues for security reports.

## System-test layer (Playwright)

The opt-in system-test layer runs your end-to-end suite in CI — this executes
consumer application code, same as the unit suite. Deterministic E2E failures may
route to the fix-agent, which, like all Northstar fixes, only ever opens a
**human-review PR and never auto-merges**. Flaky E2E failures are quarantined and
never trigger an automated fix.
