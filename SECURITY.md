# Security

Northstar is a **public, others-consumable** GitHub Actions package. It is designed
to be safe to run inside another repo's CI, and safe to have its source public.

## What this package does NOT contain
- **No secrets, tokens, or API keys.** Nothing in this repo or its git history is a
  credential. Any credentials a future version needs (e.g. an LLM API key for the
  fix-agent) are supplied by the **consuming** repo via its own encrypted secrets and
  are never stored here.

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
- **No dynamic `ref:` checkouts** of untrusted input.
- **Pinned actions.** Third-party steps use first-party GitHub actions
  (`actions/checkout`, `actions/setup-node`) at major-version tags. SHA-pinning is on
  the roadmap for stricter supply-chain guarantees.

## Reporting a vulnerability
Open a private security advisory on this repository, or contact the owner directly.
Please do not file public issues for security reports.
