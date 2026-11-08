---
name: toodo
description: Record task plans, notes, dependencies, references, and status in Toodo.
---

# Task records

Call list_workspaces and search_tasks before creating records. Read get_task for the task description, notes, references, status history, dependencies, dependents, and related tasks. current_task finds a task by ref, such as lane:search; use get_task with id when the task id is known.

{{task-description}}

# Work and memory

{{other-tasks}}

{{merge-policy}}

# Completion and review

{{completion}}

{{review-timing}}

Use add_dependency for prerequisites and add_related for context. Dependencies must remain acyclic. Read review_report to summarize recorded work in a period.
