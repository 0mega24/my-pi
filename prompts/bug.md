---
description: Triage a bug with reproduction, root cause, and fix plan
argument-hint: "<bug or symptom>"
---

Investigate this bug: $ARGUMENTS

Work in this order:

1. Reproduce or define the smallest observable failing behavior. Ask one question if the report is too ambiguous to reproduce.
2. Use `rg`, `symbol_search`, `module_report`, `read_symbol`, and `read_enclosing` to trace the likely flow.
3. Use `git_inspect` for repository state and recent changes when relevant.
4. Use `lsp_diagnostics` on implicated files before proposing implementation changes.
5. Identify root cause, affected files, a regression test plan, and the smallest safe fix.

Do not implement until the reproduction/root-cause/fix plan is clear unless the user explicitly asked for an immediate fix.
