---
description: Verify current work and summarize the final state
argument-hint: "[focus]"
---

Finish the current task end-to-end. Focus: ${ARGUMENTS:-current changes}.

Use Pi-native tools where possible:

1. Inspect repository state with `git_inspect status` and `git_inspect changed_files`.
2. Inspect the diff with `git_inspect diff` and, if staged changes exist, `git_inspect staged_diff`.
3. Run proactive diagnostics with `lsp_diagnostics` on touched source files/directories before build commands.
4. Run the project's available check/format/lint/test commands. If a command does not exist, say so and suggest adding one.
5. Run `lens_diagnostics mode=all` before declaring done.
6. Summarize: files changed, verification commands/results, remaining risks, and next action.

Do not hide failures. If verification fails, stop and explain the smallest next fix.
