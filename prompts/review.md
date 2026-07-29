---
description: Review current git changes for correctness, safety, and maintainability
argument-hint: "[focus]"
---

Review the current changes. Focus: ${ARGUMENTS:-bugs, regressions, security issues, tests, and maintainability}.

Use Pi-native inspection tools:

1. Use `git_inspect status` and `git_inspect diff` instead of shelling out to git.
2. For touched code, use `module_report`, `read_symbol`, or `read_enclosing` to inspect relevant symbols without dumping whole files.
3. Use `symbol_search` or `rg` only when you need more context across files.
4. Run `lsp_diagnostics` on touched source files when type/language errors are plausible.
5. Prefer `lens_diagnostics mode=all` for final blocking/error checks.

Return findings grouped by severity. Include file paths and line references where possible. If no issues are found, say what was checked and why it looks safe.
