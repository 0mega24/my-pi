---
description: Turn a task into concrete steps with verification checkpoints
argument-hint: "<task>"
---

Plan this work: $ARGUMENTS

Create a concise implementation plan with:

- goal and non-goals
- likely files/modules to inspect or change
- risks and assumptions
- step → verify command/check pairs
- one open question if scope is ambiguous

Use `symbol_search`, `project_report`, `module_report`, `git_inspect`, and `rg` for lightweight discovery. Prefer specific verification commands over vague acceptance criteria.
