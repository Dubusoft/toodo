# Quickstart

From installing Toodo to a first completed task, on one Linux machine. Plan on about ten
minutes.

Toodo tracks work; it doesn't run it. You or your agents do the work wherever you like,
and record its start, progress, and completion in Toodo.

## 1. Check the Prerequisites

On the Linux machine that will run the server (x64 or arm64, glibc):

- Node.js 18 or later with npm.

`claude` (Claude Code) or `codex` on `PATH` is optional. When they're there, `toodo init`
registers Toodo's MCP server with them.

## 2. Install and Start the Server

```sh
npm i -g @dubusoft/toodo
toodo init
toodo service install
```

`toodo init` creates the data directory (`~/.local/share/toodo-server` by default),
starts the server on `127.0.0.1:47616`, and registers its MCP endpoint with Claude Code
and Codex where they are installed. It prints the web app URL and the file that holds the
web access token. `toodo service install` keeps the server running as the systemd user
service `toodo-server.service`, also after a reboot. `toodo status` shows whether it runs.

## 3. Sign In

Open `http://127.0.0.1:47616` in a browser on the same machine. To use the app from
another device, put the server behind a tunnel first; see
[Off the Machine](server.md#off-the-machine-cloudflare-tunnel-and-access) in
`docs/server.md`.

The sign-in form asks for the access token. Print it on the server and paste it:

```sh
cat ~/.local/share/toodo-server/web-token
```

The browser then gets a device token of its own, which Settings > Devices lists.

## 4. Create a Workspace

A workspace groups related tasks. Add one from the sidebar and give it a name. A
description and a repository reference are optional; the reference is any string, such
as `acme/my-app`, and a GitHub `owner/repo` value shows as a link.

An agent can do the same with the `create_workspace` MCP tool.

## 5. Plan a Task

Type a title in **New task** at the top of the workspace, e.g. "Add a health check
endpoint", and expand the form to add a type, a description, labels, an estimate, and
criteria. Say in the description what the outcome is and why. A criterion is either
checked by hand or is a URL that Toodo fetches when the task completes. Select
**Add task**.

To make one task wait for another, pick the prerequisite in "Add dependency..." in the
task's details, or on the timeline drag from the prerequisite's right handle to the task
that waits for it. A task can start only once every task it depends on is done.

![Tasks of a workspace, oldest first](images/task-list.png)

## 6. Start It and Record Progress

Select **Start** on the task; it's now `in_progress`. Through MCP, an agent calls
`start_task` with a reason and refs, such as `lane:health` or `branch:feat/health`, that
tie the task to where the work happens.

Then do the work. Toodo keeps what you tell it: progress and decision notes
(`add_progress_note`), blockers (`report_blocker`), and pauses with their reasons
(`pause_task`, `resume_task`). When the work waits for review, move the task to
`in_review` (`update_task` with `status: "in_review"` and a ref such as `pr:<url>`).

## 7. Complete It

Once the work shipped, check the task's manual criteria and select **Complete**, or call
`complete_task` with a note through MCP. The task is `done`, the note and timestamps are
recorded, and every task that depended on it can start.

That's the whole loop. Next:

- The **Review** page in the sidebar reports what was planned, started, and completed in
  a week, month, quarter, or year; see "Review" in the [README](../README.md#review).
- [agents.md](agents.md) shows how a coding agent plans tasks and records its work
  through Toodo's MCP tools.
- [troubleshooting.md](troubleshooting.md) covers the errors new setups run into most.
- [workflow.md](workflow.md) describes every step of the task lifecycle in detail.
