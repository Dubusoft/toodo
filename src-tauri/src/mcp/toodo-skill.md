---
name: toodo
description: Record task plans, notes, dependencies, references, and status in Toodo.
---

# Task records

Call list_workspaces and search_tasks before creating records. Read get_task for the task description, notes, references, status history, dependencies, dependents, and related tasks. current_task finds a task by ref, such as lane:search; use get_task with id when the task id is known.

{{task-description}}

# Work and memory

{{guidelines}}

{{other-tasks}}

Set autopilot true in create_task, create_plan, or update_task only when the user asks for autopilot on that task: an executor may then take it up on its own once it is ready. A follow-up task is not marked unless the user asks for that one too. update_task with autopilot false clears the mark. list_tasks with autopilot true lists the marked tasks of every workspace, or of workspace_id; autopilotAt says since when each one is marked.

{{merge-policy}}

# Completion and review

{{completion}}

{{review-timing}}

Use add_dependency for prerequisites and add_related for context. Dependencies must remain acyclic. Read review_report to summarize recorded work in a period.
