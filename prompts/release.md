---
description: Run a release/PR readiness checklist for current changes
argument-hint: "[release notes focus]"
---

Prepare the current changes for release or PR. Focus: ${ARGUMENTS:-current branch}.

Checklist:

1. Use `git_inspect status`, `git_inspect branch`, and `git_inspect diff` to understand current changes.
2. Check for secrets, credentials, environment files, production config, destructive migrations, or risky dependency changes.
3. Run `lsp_diagnostics` on touched source files/directories.
4. Run project check/format/lint/test/build commands where available.
5. Run `lens_diagnostics mode=all`.
6. Summarize release readiness, risks, verification evidence, and a Conventional Commits-style commit/PR title and body.

If anything fails, stop and report the blocker instead of calling the release ready.
