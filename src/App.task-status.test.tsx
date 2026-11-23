import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@/lib/bindings";
import { formatFull, formatWhen } from "@/lib/timeline";
import {
  chooseAction,
  chooseOption,
  criterion,
  findAlert,
  isDisabled,
  mocked,
  openDetails,
  openOptions,
  renderApp,
  renderWorkspace,
  row,
  setUpApp,
  task,
  taskList,
  toodo,
} from "@/test/app";

describe("App: task status and completion", () => {
  setUpApp();

  it("shows command errors returned by the backend", async () => {
    mocked.listWorkspaces.mockResolvedValue({
      status: "error",
      error: { kind: "internal", code: "internal", message: "database is locked" },
    });
    renderApp();

    expect(await findAlert()).toHaveTextContent("database is locked");
  });

  it("shows why a task could not be started", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [task(1, 1, "Add login")] });
    mocked.startTask.mockResolvedValue({
      status: "error",
      error: { kind: "invalidInput", code: "invalidInput", message: "worktree root is not set for machine local" },
    });
    await renderWorkspace();

    const start = await screen.findByRole("button", { name: "Start #1" });
    await waitFor(() => expect(isDisabled(start)).toBe(false));
    fireEvent.click(start);

    expect(await findAlert()).toHaveTextContent("worktree root is not set for machine local");
    expect(within(row("Add login")).getByText("Ready")).toBeInTheDocument();
  });

  it("shows why a task could not be completed", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add login", {
          status: "in_review",
        }),
      ],
    });
    mocked.completeTask.mockResolvedValue({
      status: "error",
      error: { kind: "rejected", code: "rejected", message: "pull request https://github.com/acme/toodo/pull/12 is not merged yet" },
    });
    await renderWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "Complete #1" }));

    expect(await findAlert()).toHaveTextContent("is not merged yet");
    expect(within(row("Add login")).getByText("Awaiting completion")).toBeInTheDocument();
    expect(isDisabled(screen.getByRole("button", { name: "Complete #1" }))).toBe(false);
  });

  it("checks a manual criterion with evidence and unchecks it", async () => {
    const docs = criterion(7, "Docs reviewed");
    const started = task(1, 1, "Add search", { status: "in_progress", criteria: [docs] });
    const checked = {
      ...started,
      criteria: [{ ...docs, state: "met" as const, evidence: "Read by Ada", checkedBy: "user" as const, checkedAt: 1760000000 }],
    };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [started] });
    mocked.checkCriterion.mockResolvedValue({ status: "ok", data: checked });
    await renderWorkspace();

    const details = await openDetails("Add search");
    const criteria = within(details).getByRole("list", { name: "Criteria of #1" });
    const box = () => within(criteria).getByRole("checkbox", { name: "Check criterion 7 of #1" });
    expect(box()).not.toBeChecked();
    fireEvent.click(box());
    // Checking asks for the evidence before anything is saved.
    expect(mocked.checkCriterion).not.toHaveBeenCalled();
    fireEvent.change(within(criteria).getByLabelText("Evidence for criterion 7"), {
      target: { value: " Read by Ada " },
    });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [checked] });
    fireEvent.click(within(criteria).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(within(criteria).queryByLabelText("Evidence for criterion 7")).not.toBeInTheDocument());
    expect(mocked.checkCriterion).toHaveBeenCalledWith(1, 7, true, "Read by Ada");
    expect(box()).toBeChecked();
    expect(within(criteria).getByText(/^Read by Ada · Checked by you/)).toBeInTheDocument();

    // Unchecking saves right away.
    mocked.checkCriterion.mockResolvedValue({ status: "ok", data: started });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [started] });
    fireEvent.click(box());

    await waitFor(() => expect(box()).not.toBeChecked());
    expect(mocked.checkCriterion).toHaveBeenLastCalledWith(1, 7, false, null);
  });

  it("marks a failed manual criterion as failed beside its checkbox", async () => {
    const failed = task(1, 1, "Add search", {
      status: "in_progress",
      criteria: [
        criterion(7, "Docs reviewed", { state: "failed", checkedBy: "user", checkedAt: 1760000000 }),
        criterion(8, "Demo recorded"),
      ],
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [failed] });
    await renderWorkspace();

    // The row counts the failure; the details sheet marks the criterion.
    await within(await taskList()).findByRole("button", { name: "Add search" });
    expect(row("Add search")).toHaveTextContent("0/2 criteria met1 failed");
    const details = await openDetails("Add search");
    const criteria = within(details).getByRole("list", { name: "Criteria of #1" });
    const [failedItem, pendingItem] = within(criteria).getAllByRole("listitem");
    expect(within(failedItem).getByRole("img", { name: "Failed" })).toBeInTheDocument();
    expect(within(failedItem).getByRole("checkbox")).not.toBeChecked();
    expect(within(pendingItem).queryByRole("img")).not.toBeInTheDocument();
  });

  it("completes a task whose criteria are all met with the enabled green Complete button", async () => {
    const met = { state: "met" as const, checkedAt: 1760000000 };
    const awaiting = task(1, 1, "Add search", {
      status: "in_review",
      criteria: [
        criterion(1, "Health check answers", {
          ...met,
          kind: "url",
          target: "https://example.com/health",
          checkedBy: "toodo",
        }),
        criterion(2, "Docs reviewed", { ...met, checkedBy: "user", evidence: "Read by Ada" }),
      ],
    });
    const done = { ...awaiting, status: "done" as const, resolution: "completed" as const };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [awaiting] });
    mocked.completeTask.mockResolvedValue({ status: "ok", data: done });
    await renderWorkspace();

    const tasks = await taskList();
    expect(within(row("Add search")).getByText("Awaiting completion")).toBeInTheDocument();
    const complete = within(tasks).getByRole("button", { name: "Complete #1" });
    expect(isDisabled(complete)).toBe(false);
    expect(complete).toHaveClass("bg-emerald-100");
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [done] });
    fireEvent.click(complete);

    expect(await within(tasks).findByRole("button", { name: "Done 1" })).toBeInTheDocument();
    expect(mocked.completeTask).toHaveBeenCalledWith(1, null, null);
    expect(within(tasks).queryByRole("button", { name: "Complete #1" })).not.toBeInTheDocument();
  });

  it("asks for a completion note on a done task and saves it", async () => {
    const done = task(1, 1, "Add login", { status: "done" });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [done] });
    await renderWorkspace();

    fireEvent.click(await within(await taskList()).findByRole("button", { name: "Done 1" }));
    const details = await openDetails("Add login");
    await chooseAction(1, "Add completion note to #1", details);
    const save = within(details).getByRole("button", { name: "Save note" });
    expect(isDisabled(save)).toBe(true);

    const noted = { ...done, completionNote: "Cut sign-in time in half" };
    mocked.setCompletionNote.mockResolvedValue({ status: "ok", data: noted });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [noted] });
    fireEvent.change(screen.getByRole("textbox", { name: "Completion note for #1" }), {
      target: { value: "Cut sign-in time in half" },
    });
    fireEvent.click(save);

    expect(await screen.findByLabelText("Completion note of #1")).toHaveTextContent("Cut sign-in time in half");
    expect(screen.queryByRole("textbox", { name: "Completion note for #1" })).not.toBeInTheDocument();
    expect(mocked.setCompletionNote).toHaveBeenCalledWith(1, "Cut sign-in time in half");
  });

  it("shows work completed without a pull request and its ready dependent", async () => {
    const shipped = task(1, 1, "Deploy configuration", {
      status: "done", resolution: "completed", completionNote: "Deployed directly",
    });
    const dependent = task(2, 1, "Verify configuration", { dependsOn: [1] });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [shipped, dependent] });
    await renderWorkspace();

    fireEvent.click(await within(await taskList()).findByRole("button", { name: "Done 1" }));

    expect(within(row("Deploy configuration")).getByText("Completed")).toBeInTheDocument();
    expect(within(row("Verify configuration")).getByText("Ready")).toBeInTheDocument();
  });

  it("concludes research without merging and keeps its dependents blocked", async () => {
    const research = task(1, 1, "Try a new cache", {
      taskType: "rnd",
      status: "in_review",
    });
    const dependent = task(2, 1, "Use the new cache", { dependsOn: [1] });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [research, dependent] });
    await renderWorkspace();

    await chooseAction(1, "Conclude #1 without completing");
    const conclude = screen.getByRole("button", { name: "Conclude as not adopted" });
    expect(isDisabled(conclude)).toBe(true);

    const concluded: Task = {
      ...research,
      status: "done",
      resolution: "not_adopted",
      completionNote: "Twice as slow as the current cache",
    };
    mocked.concludeTask.mockResolvedValue({ status: "ok", data: concluded });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [concluded, dependent] });
    fireEvent.change(screen.getByRole("textbox", { name: "Conclusion of #1" }), {
      target: { value: "  Twice as slow as the current cache " },
    });
    fireEvent.click(conclude);

    // Concluded research is done, so it moves to the folded Done section.
    fireEvent.click(await within(await taskList()).findByRole("button", { name: "Done 1" }));
    expect(mocked.concludeTask).toHaveBeenCalledWith(1, "Twice as slow as the current cache", "not_adopted", null);
    expect(within(row("Try a new cache")).getByText("Not adopted")).toBeInTheDocument();
    expect(screen.getByRole("note", { name: "Blocked prerequisites of #2" })).toHaveTextContent("#1 not adopted");
    expect(isDisabled(screen.getByRole("button", { name: "Start #2" }))).toBe(true);
    const details = await openDetails("Try a new cache");
    expect(within(details).getByLabelText("Completion note of #1")).toHaveTextContent(
      "Twice as slow as the current cache",
    );
  });

  it("concludes a planned task as not adopted without starting it", async () => {
    const prerequisite = task(1, 1, "Pick a cache");
    const idea = task(2, 1, "Try a second cache", { dependsOn: [1] });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [prerequisite, idea] });
    await renderWorkspace();

    await chooseAction(2, "Conclude #2 without completing");
    const concluded: Task = { ...idea, status: "done", resolution: "not_adopted", completionNote: "Not needed" };
    mocked.concludeTask.mockResolvedValue({ status: "ok", data: concluded });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [prerequisite, concluded] });
    fireEvent.change(screen.getByRole("textbox", { name: "Conclusion of #2" }), { target: { value: "Not needed" } });
    fireEvent.click(screen.getByRole("button", { name: "Conclude as not adopted" }));

    fireEvent.click(await within(await taskList()).findByRole("button", { name: "Done 1" }));
    expect(mocked.concludeTask).toHaveBeenCalledWith(2, "Not needed", "not_adopted", null);
    expect(mocked.startTask).not.toHaveBeenCalled();
    expect(within(row("Try a second cache")).getByText("Not adopted")).toBeInTheDocument();
  });

  it("reopens a done task with a reason and shows it paused and reopened", async () => {
    const done = task(1, 1, "Add login", {
      status: "done",
      resolution: "merged",
      milestones: { plannedAt: 100, startedAt: 200, reviewAt: null, completedAt: 300, reopenedAt: null, pausedAt: null, lastReviewAt: null, activeSeconds: 100, pauseCount: 0 },
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [done] });
    await renderWorkspace();

    fireEvent.click(await within(await taskList()).findByRole("button", { name: "Done 1" }));
    const details = await openDetails("Add login");
    await chooseAction(1, "Reopen #1", details);
    const reopen = within(details).getByRole("button", { name: "Reopen" });
    expect(isDisabled(reopen)).toBe(true);

    const reopened: Task = {
      ...done,
      status: "planned",
      resolution: null,
      milestones: { ...done.milestones, completedAt: null, reopenedAt: 400, pausedAt: 400 },
    };
    mocked.reopenTask.mockResolvedValue({ status: "ok", data: reopened });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [reopened] });
    fireEvent.change(within(details).getByRole("textbox", { name: "Reason to reopen #1" }), {
      target: { value: " Missed the logout case " },
    });
    fireEvent.click(reopen);

    expect(await within(details).findByRole("button", { name: "Resume #1" })).toBeInTheDocument();
    expect(mocked.reopenTask).toHaveBeenCalledWith(1, "Missed the logout case");
    expect(within(details).getByLabelText("Timeline of #1")).toHaveTextContent("Reopened");
  });

  it("corrects the outcome of a done task with a note", async () => {
    const done = task(1, 1, "Add login", { status: "done", resolution: "merged" });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [done] });
    await renderWorkspace();

    fireEvent.click(await within(await taskList()).findByRole("button", { name: "Done 1" }));
    const details = await openDetails("Add login");
    await chooseAction(1, "Change outcome of #1", details);
    const outcome = within(details).getByRole("combobox", { name: "New outcome of #1" });
    expect(within(openOptions(outcome)).queryByRole("option", { name: "Merged" })).not.toBeInTheDocument();

    const corrected: Task = { ...done, resolution: "not_adopted", completionNote: "Reverted the next day" };
    mocked.setTaskOutcome.mockResolvedValue({ status: "ok", data: corrected });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [corrected] });
    chooseOption(outcome, /^Not adopted/);
    fireEvent.change(within(details).getByRole("textbox", { name: "Outcome note of #1" }), {
      target: { value: "Reverted the next day" },
    });
    fireEvent.click(within(details).getByRole("button", { name: "Change outcome" }));

    expect(await within(details).findByLabelText("Completion note of #1")).toHaveTextContent("Reverted the next day");
    expect(mocked.setTaskOutcome).toHaveBeenCalledWith(1, "not_adopted", "Reverted the next day");
  });

  it("completes an active task as shipped by another task from the Conclude form", async () => {
    const batch = task(1, 1, "Add login", { status: "done", resolution: "completed" });
    const planned = task(3, 1, "Add logout");
    const extra = task(2, 1, "Fix typo", {
      status: "in_progress",
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [batch, extra, planned] });
    await renderWorkspace();

    await chooseAction(2, "Conclude #2 without completing");
    fireEvent.click(screen.getByRole("button", { name: "Complete #2 as shipped by another task" }));
    const shipper = screen.getByRole("combobox", { name: "Task that shipped #2" });
    // Only work that shipped can be named.
    expect(within(openOptions(shipper)).queryByRole("option", { name: "#3 Add logout" })).not.toBeInTheDocument();

    const done: Task = {
      ...extra,
      status: "done",
      resolution: "completed",
      completionNote: "Fixed in #1",
      refs: ["task:1"],
    };
    mocked.concludeTask.mockResolvedValue({ status: "ok", data: done });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [batch, done, planned] });
    chooseOption(shipper, "#1 Add login");
    fireEvent.change(screen.getByRole("textbox", { name: "Shipped note of #2" }), { target: { value: "Fixed in #1" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete as shipped" }));

    fireEvent.click(await within(await taskList()).findByRole("button", { name: "Done 2" }));
    expect(mocked.concludeTask).toHaveBeenCalledWith(2, "Fixed in #1", "shipped_with", 1);
    const details = await openDetails("Fix typo");
    expect(await within(details).findByRole("list", { name: "Refs of #2" })).toHaveTextContent("task:1");
  });

  it("waits to resume a task in progress that got a prerequisite", async () => {
    const fix = task(1, 1, "Fix login");
    const started = task(2, 1, "Verify login", {
      status: "in_progress",
      milestones: { ...task(2, 1, "").milestones, plannedAt: 1760000000, startedAt: 1760100000 },
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [fix, started] });
    mocked.addDependency.mockResolvedValue({ status: "ok", data: "confirm_pause" });
    await renderWorkspace();

    const details = await openDetails("Verify login");
    const add = within(details).getByRole("combobox", { name: "Add dependency to #2" });
    chooseOption(add, "#1 Fix login");
    const confirmation = await screen.findByRole("group", { name: "Confirm prerequisite of #2" });
    mocked.addDependency.mockResolvedValue({ status: "ok", data: "added" });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [fix, { ...started, status: "planned", dependsOn: [1] }],
    });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Pause and add" }));

    expect(await within(details).findByRole("note", { name: "Waiting prerequisites of #2" })).toHaveTextContent(
      "Waiting on #1",
    );
    expect(mocked.addDependency).toHaveBeenCalledWith(2, 1, true);
    expect(isDisabled(within(details).getByRole("button", { name: "Resume #2" }))).toBe(true);
    expect(within(row("Verify login")).getByRole("note", { name: "Waiting prerequisites of #2" })).toBeInTheDocument();
  });

  it("shows which prerequisites a planned task waits on", async () => {
    const done = task(1, 1, "Add storage", { status: "done", resolution: "merged" });
    const open = task(2, 1, "Add login");
    const blocked = task(3, 1, "Verify login", { dependsOn: [1, 2] });
    const ready = task(4, 1, "Add logout", { dependsOn: [1] });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [done, open, blocked, ready] });
    await renderWorkspace();

    const note = await screen.findByRole("note", { name: "Waiting prerequisites of #3" });
    expect(note).toHaveTextContent(/^Waiting on #2$/);
    expect(note).toHaveClass("text-muted-foreground");
    expect(isDisabled(screen.getByRole("button", { name: "Start #3" }))).toBe(true);
    expect(screen.queryByRole("note", { name: "Waiting prerequisites of #4" })).not.toBeInTheDocument();
  });

  it("marks a task whose agent reported a blocker in the list and shows every note in the task details", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const plannedAt = new Date(2026, 5, 1).getTime() / 1000;
    const noted = task(1, 1, "Add login", {
      status: "in_progress",
      milestones: { ...task(0, 1, "").milestones, plannedAt, startedAt: plannedAt + 3600 },
      notes: [
        { kind: "progress", body: "Chose **PKCE** over the implicit flow", at: plannedAt + 7200 },
        { kind: "blocker", body: "Need a test account for the provider", at: plannedAt + 10800 },
      ],
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [noted, task(2, 1, "Add logout")] });
    await renderWorkspace();

    const tasks = await taskList();
    expect(within(tasks).getByRole("note", { name: "Blocker on #1: Need a test account for the provider" })).toBeInTheDocument();
    expect(within(row("Add logout")).queryByText("Blocker")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    const bars = timeline.querySelector(".react-flow__nodes") as HTMLElement;
    fireEvent.click((await within(bars).findByText("Add login")).closest(".react-flow__node") as HTMLElement);
    const details = await within(timeline).findByRole("complementary", { name: "Task details" });
    const notes = await within(details).findByRole("list", { name: "Notes of #1" });
    const items = within(notes).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector("[data-note-kind]")?.textContent)).toEqual(["Progress", "Blocker"]);
    expect(await within(items[0]).findByText("PKCE")).toBeInTheDocument();
    expect(items[1]).toHaveTextContent("Need a test account for the provider");
  });

  it("asks before a prerequisite pauses a started task, whatever its agent does", async () => {
    const fix = task(1, 1, "Fix login");
    const started = task(2, 1, "Verify login", {
      status: "in_progress",
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [fix, started] });
    // The server decides that the prerequisite pauses the task and asks for confirmation.
    mocked.addDependency.mockResolvedValue({ status: "ok", data: "confirm_pause" });
    await renderWorkspace();
    const details = await openDetails("Verify login");
    const add = () => within(details).getByRole("combobox", { name: "Add dependency to #2" });

    chooseOption(add(), "#1 Fix login");
    const confirmation = await screen.findByRole("group", { name: "Confirm prerequisite of #2" });
    expect(confirmation).toHaveTextContent("Adding #1 as a prerequisite pauses #2");
    // The question takes the place of the dependency row instead of pushing the row down.
    expect(screen.queryByRole("group", { name: "Dependencies of #2" })).not.toBeInTheDocument();
    expect(mocked.addDependency).toHaveBeenCalledWith(2, 1, false);
    fireEvent.click(within(confirmation).getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("group", { name: "Confirm prerequisite of #2" })).not.toBeInTheDocument();
    expect(mocked.addDependency).not.toHaveBeenCalledWith(2, 1, true);

    chooseOption(add(), "#1 Fix login");
    const again = await screen.findByRole("group", { name: "Confirm prerequisite of #2" });
    mocked.addDependency.mockResolvedValue({ status: "ok", data: "added" });
    fireEvent.click(within(again).getByRole("button", { name: "Pause and add" }));
    await waitFor(() => expect(mocked.addDependency).toHaveBeenCalledWith(2, 1, true));
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Confirm prerequisite of #2" })).not.toBeInTheDocument(),
    );
  });

  it("makes a started task wait until a time, moves the time, and ends the wait", async () => {
    const started = task(1, 1, "Add login", {
      status: "in_progress",
      milestones: { ...task(1, 1, "").milestones, plannedAt: 1760000000, startedAt: 1760100000 },
    });
    const until = new Date(2030, 0, 2, 9, 30).getTime() / 1000;
    const waiting: Task = {
      ...started,
      status: "planned",
      milestones: { ...started.milestones, pausedAt: 1760200000 },
      wait: { until, status: "in_progress" },
    };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [started] });
    mocked.waitTask.mockResolvedValue({ status: "ok", data: waiting });
    mocked.endWait.mockResolvedValue({ status: "ok", data: started });
    await renderWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "More actions for #1" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Wait #1" }));
    const form = await screen.findByRole("form", { name: "Wait #1" });
    fireEvent.change(within(form).getByLabelText("Wait #1 until"), { target: { value: "2030-01-02T09:30" } });
    fireEvent.change(within(form).getByLabelText("Reason #1 waits"), { target: { value: " Vendor reply " } });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [waiting] });
    fireEvent.click(within(form).getByRole("button", { name: "Wait" }));
    await waitFor(() => expect(mocked.waitTask).toHaveBeenCalledWith(1, until, "Vendor reply"));
    expect(await screen.findByRole("note", { name: "Wait of #1" })).toHaveTextContent(
      `Waiting until ${formatFull(until)}, then in progress`,
    );

    // A waiting task opens the form with its time, to move it.
    fireEvent.click(screen.getByRole("button", { name: "More actions for #1" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Change wait of #1" }));
    const change = await screen.findByRole("form", { name: "Wait #1" });
    expect(within(change).getByLabelText("Wait #1 until")).toHaveValue("2030-01-02T09:30");
    fireEvent.click(within(change).getByRole("button", { name: "Back" }));

    fireEvent.click(screen.getByRole("button", { name: "More actions for #1" }));
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [started] });
    fireEvent.click(await screen.findByRole("menuitem", { name: "End wait of #1" }));
    await waitFor(() => expect(mocked.endWait).toHaveBeenCalledWith(1));
    await waitFor(() => expect(screen.queryByRole("note", { name: "Wait of #1" })).not.toBeInTheDocument());
  });

  it("pauses a started task, then resumes or deletes it", async () => {
    const started = task(1, 1, "Add login", {
      status: "in_progress",
      milestones: { ...task(1, 1, "").milestones, plannedAt: 1760000000, startedAt: 1760100000 },
    });
    const paused: Task = {
      ...started,
      status: "planned",
      milestones: { ...started.milestones, pausedAt: 1760200000 },
    };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [started] });
    mocked.pauseTask.mockResolvedValue({ status: "ok", data: paused });
    mocked.deleteTask.mockResolvedValue({ status: "ok", data: null });
    await renderWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "More actions for #1" }));
    const pause = await screen.findByRole("menuitem", { name: "Pause #1" });
    expect(screen.queryByRole("menuitem", { name: "Delete #1" })).not.toBeInTheDocument();
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [paused] });
    fireEvent.click(pause);

    expect(isDisabled(await screen.findByRole("button", { name: "Resume #1" }))).toBe(false);
    expect(mocked.pauseTask).toHaveBeenCalledWith(1);
    expect(within(row("Add login")).getByText("Paused")).toBeInTheDocument();
    expect(row("Add login")).toHaveTextContent(`Paused ${formatWhen(1760200000)}`);

    // Secondary actions sit in the More menu, Delete last and in the destructive style.
    fireEvent.click(screen.getByRole("button", { name: "More actions for #1" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
      "Show details of #1",
      "Conclude #1 without completing",
      "Edit #1",
      "Wait #1",
      "Delete #1",
    ]);
    expect(items.at(-1)).toHaveAttribute("data-variant", "destructive");
    fireEvent.click(items.at(-1) as HTMLElement);
    expect(mocked.deleteTask).not.toHaveBeenCalled();
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete #1" }));

    expect(await screen.findByText("No tasks in this workspace yet.")).toBeInTheDocument();
    expect(mocked.deleteTask).toHaveBeenCalledWith(1);
  });
});
