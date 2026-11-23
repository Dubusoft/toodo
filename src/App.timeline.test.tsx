import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@/lib/bindings";
import { formatWhen } from "@/lib/timeline";
import {
  chooseAction,
  chooseOption,
  herdr,
  mocked,
  openDetails,
  openOptions,
  optionNames,
  renderApp,
  renderWorkspace,
  row,
  setUpApp,
  task,
  taskList,
  toodo,
} from "@/test/app";

describe("App: timeline", () => {
  setUpApp();

  it("plans dependencies across workspaces and lists every workspace together", async () => {
    const api = task(1, 1, "Add low level API");
    const ui = task(3, 2, "Build UI");
    const docs = task(4, 2, "Write docs");
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [api, ui, docs] });
    mocked.addDependency.mockResolvedValue({ status: "ok", data: "added" });
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: /^herdr/ }));
    const details = await openDetails("Build UI");
    const add = await within(details).findByRole("combobox", { name: "Add dependency to #3" });
    const groups = within(openOptions(add)).getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["herdr", "toodo"]);
    expect(within(groups[1]).getByRole("option", { name: "#1 Add low level API" })).toBeInTheDocument();

    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [api, { ...ui, status: "planned", dependsOn: [1] }, docs],
    });
    chooseOption(add, "#1 Add low level API");
    const dependencies = await screen.findByRole("group", { name: "Dependencies of #3" });
    await waitFor(() => expect(within(dependencies).getByText("toodo #1")).toBeInTheDocument());
    expect(mocked.addDependency).toHaveBeenCalledWith(3, 1, false);

    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    expect(await screen.findByRole("heading", { name: "All workspaces" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    const tasks = await taskList();
    expect(within(tasks).getAllByRole("listitem")).toHaveLength(3);
    expect(within(tasks).getByText("Add low level API")).toBeInTheDocument();
    expect(within(tasks).getByText("Write docs")).toBeInTheDocument();
    const all = await openDetails("Build UI");
    expect(within(within(all).getByRole("group", { name: "Dependencies of #3" })).getByText("toodo #1")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "New task" })).not.toBeInTheDocument();
  });

  it("shows the tasks of every workspace on a timeline, narrowed to one workspace on request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const day = 24 * 60 * 60;
    const plannedAt = new Date(2026, 5, 1).getTime() / 1000;
    const planned = (at: number) => ({ ...task(0, 1, "").milestones, plannedAt: at });
    const lastYear = new Date(2025, 5, 1).getTime() / 1000;
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(5, 2, "Add herdr API", { status: "planned", dependsOn: [1], milestones: planned(plannedAt + day) }),
        task(1, 1, "Add storage", {
          status: "done",
          milestones: { ...planned(plannedAt), completedAt: plannedAt + 3 * day },
        }),
        task(2, 1, "Add UI", { status: "planned", dependsOn: [1], milestones: planned(plannedAt + day) }),
        task(3, 1, "Write docs", { status: "in_progress" }),
        task(4, 1, "Fix login", {
          status: "done",
          milestones: { ...planned(lastYear), completedAt: lastYear + day },
        }),
      ],
    });
    await renderWorkspace();

    await taskList();
    expect(screen.queryByRole("button", { name: "Timeline" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));

    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    expect(screen.getByRole("button", { name: "Timeline" })).toHaveAttribute("aria-pressed", "true");
    expect(await within(timeline).findByText("Add herdr API")).toBeInTheDocument();
    expect(await within(timeline).findByText("Add UI")).toBeInTheDocument();
    // The timeline leaves finished tasks out until they are asked for.
    expect(within(timeline).queryByText("Add storage")).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Status filter" })).getByRole("button", { name: "Done" }));
    expect(await within(timeline).findByText("Add storage")).toBeInTheDocument();
    const unplaced = within(timeline).getByRole("complementary", { name: "Tasks without a planned date" });
    expect(within(unplaced).getByText("Write docs")).toBeInTheDocument();
    expect(within(timeline).getByRole("button", { name: "Week" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("region", { name: "Tasks" })).not.toBeInTheDocument();

    fireEvent.click(within(timeline).getByRole("button", { name: "Month" }));
    expect(within(timeline).getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "true");
    const period = within(timeline).getByRole("combobox", { name: "Timeline period" });
    expect(optionNames(period)).toEqual([
      "All time",
      "2026",
      "2025",
    ]);
    chooseOption(period, "2025");
    expect(await within(timeline).findByText("Fix login")).toBeInTheDocument();
    expect(within(timeline).queryByText("Add UI")).not.toBeInTheDocument();
    expect(within(unplaced).getByText("Write docs")).toBeInTheDocument();
    chooseOption(period, "All time");

    const filter = screen.getByRole("combobox", { name: "Timeline workspace" });
    expect(optionNames(filter)).toEqual([
      "All workspaces",
      "herdr",
      "toodo",
    ]);
    expect(within(timeline).getByText("Add storage").closest("[data-dimmed]")).toBeNull();
    chooseOption(filter, "herdr");
    expect(await within(timeline).findByText("Add herdr API")).toBeInTheDocument();
    expect(within(timeline).queryByText("Add UI")).not.toBeInTheDocument();
    expect(within(timeline).queryByText("Write docs")).not.toBeInTheDocument();
    // The prerequisite in another workspace stays on the timeline, dimmed and labeled.
    const prerequisite = within(timeline).getByText("Add storage").closest("[data-dimmed]");
    expect(prerequisite).not.toBeNull();
    expect(within(prerequisite as HTMLElement).getByText("toodo")).toBeInTheDocument();
    expect(within(timeline).getByText("Add herdr API").closest("[data-dimmed]")).toBeNull();
  });

  it("filters the tasks that can be started now in the list and on the timeline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const plannedAt = new Date(2026, 5, 1).getTime() / 1000;
    const planned = { ...task(0, 1, "").milestones, plannedAt };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage", {
          status: "done",
          resolution: "merged",
          milestones: { ...planned, completedAt: plannedAt + 3600 },
        }),
        task(2, 1, "Add UI", { dependsOn: [1], milestones: planned }),
        task(3, 1, "Write docs", { dependsOn: [4], milestones: planned }),
        task(4, 2, "Fix ssh", { status: "in_progress", milestones: planned }),
      ],
    });
    await renderWorkspace();

    const tasks = await taskList();
    expect(await within(tasks).findByText("Add UI")).toBeInTheDocument();
    expect(within(row("Add UI")).getByText("Ready")).toBeInTheDocument();
    expect(within(row("Write docs")).getByText("Blocked")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Status filter" })).getByRole("button", { name: "Ready" }));
    expect(within(tasks).getAllByRole("listitem")).toHaveLength(1);
    expect(within(tasks).getByText("Add UI")).toBeInTheDocument();

    // Waiting on a task of another workspace keeps #3 out of the timeline too.
    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    const bars = timeline.querySelector(".react-flow__nodes") as HTMLElement;
    expect(await within(bars).findByText("Write docs")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Status filter" })).getByRole("button", { name: "Ready" }));
    expect(await within(bars).findByText("Add UI")).toBeInTheDocument();
    expect(within(bars).getByText("Ready")).toBeInTheDocument();
    expect(within(bars).queryByText("Write docs")).not.toBeInTheDocument();
    expect(within(bars).queryByText("Add storage")).not.toBeInTheDocument();
  });

  it("opens the details of a task clicked on the timeline and fades tasks outside its chain", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const plannedAt = new Date(2026, 5, 1).getTime() / 1000;
    const planned = { ...task(0, 1, "").milestones, plannedAt };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage", { status: "done", milestones: { ...planned, completedAt: plannedAt + 3600 } }),
        task(2, 1, "Add UI", { dependsOn: [1], milestones: planned }),
        task(3, 1, "Write docs", { milestones: planned }),
      ],
    });
    await renderWorkspace();

    await taskList();
    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    // The details panel names other tasks too, as dependency choices; look only at the bars.
    const bar = (title: string) =>
      within(timeline.querySelector(".react-flow__nodes") as HTMLElement)
        .getByText(title)
        .closest(".react-flow__node") as HTMLElement;
    await within(timeline).findByText("Add UI");
    fireEvent.click(within(screen.getByRole("group", { name: "Status filter" })).getByRole("button", { name: "Done" }));
    await within(timeline).findByText("Add storage");
    expect(within(timeline).queryByRole("complementary", { name: "Task details" })).not.toBeInTheDocument();

    fireEvent.click(bar("Add UI"));
    const details = await within(timeline).findByRole("complementary", { name: "Task details" });
    expect(within(details).getByRole("button", { name: "Start #2" })).toBeInTheDocument();
    expect(within(details).getByRole("heading", { name: "Add UI" })).toBeInTheDocument();
    expect(bar("Write docs").querySelector("[data-dimmed]")).not.toBeNull();
    expect(bar("Add storage").querySelector("[data-dimmed]")).toBeNull();
    expect(bar("Add UI").querySelector("[data-dimmed]")).toBeNull();

    fireEvent.click(bar("Write docs"));
    expect(await within(details).findByRole("button", { name: "Start #3" })).toBeInTheDocument();
    expect(bar("Add UI").querySelector("[data-dimmed]")).not.toBeNull();

    fireEvent.keyDown(within(details).getByRole("button", { name: "Close details" }), { key: "Escape" });
    await waitFor(() =>
      expect(within(timeline).queryByRole("complementary", { name: "Task details" })).not.toBeInTheDocument(),
    );
    expect(bar("Add UI").querySelector("[data-dimmed]")).toBeNull();

    bar("Add UI").focus();
    fireEvent.click(bar("Add UI"));
    expect(
      within(await within(timeline).findByRole("complementary", { name: "Task details" })).getByRole("heading", {
        name: "Task details",
      }),
    ).toHaveFocus();
    fireEvent.click(await within(timeline).findByRole("button", { name: "Close details" }));
    expect(within(timeline).queryByRole("complementary", { name: "Task details" })).not.toBeInTheDocument();
    expect(bar("Add UI")).toHaveFocus();
  });

  it("summarizes a hovered timeline bar and moves between rows with the arrow keys", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const plannedAt = new Date(2026, 5, 1).getTime() / 1000;
    const planned = { ...task(0, 1, "").milestones, plannedAt };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage", { status: "done", milestones: { ...planned, completedAt: plannedAt + 3600 } }),
        task(2, 1, "Add UI", { dependsOn: [1], milestones: planned }),
        task(3, 1, "Write docs", { dependsOn: [2], milestones: planned }),
      ],
    });
    await renderWorkspace();

    await taskList();
    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    const bar = (title: string) =>
      within(timeline.querySelector(".react-flow__nodes") as HTMLElement)
        .getByText(title)
        .closest(".react-flow__node") as HTMLElement;
    await within(timeline).findByText("Write docs");
    fireEvent.click(within(screen.getByRole("group", { name: "Status filter" })).getByRole("button", { name: "Done" }));
    await within(timeline).findByText("Add storage");

    fireEvent.mouseEnter(bar("Add storage"));
    const summary = await screen.findByRole("tooltip", { name: "Summary of #1" });
    expect(summary).toHaveTextContent("Add storage");
    expect(summary).toHaveTextContent(`Completed${formatWhen(plannedAt + 3600)}`);
    fireEvent.mouseLeave(bar("Add storage"));
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());

    // Rows follow the dependency chain: storage, then UI, then docs.
    const heading = async (title: string) =>
      within(await within(timeline).findByRole("complementary", { name: "Task details" })).findByRole("heading", {
        name: title,
      });
    bar("Add storage").focus();
    fireEvent.keyDown(bar("Add storage"), { key: "ArrowDown" });
    expect(await heading("Add UI")).toBeInTheDocument();
    expect(bar("Add UI")).toHaveFocus();
    fireEvent.keyDown(bar("Add UI"), { key: "ArrowDown" });
    expect(await heading("Write docs")).toBeInTheDocument();
    fireEvent.keyDown(bar("Write docs"), { key: "ArrowUp" });
    expect(await heading("Add UI")).toBeInTheDocument();
    fireEvent.keyDown(bar("Add UI"), { key: "Home" });
    expect(await heading("Add storage")).toBeInTheDocument();
    fireEvent.keyDown(bar("Add storage"), { key: "End" });
    expect(await heading("Write docs")).toBeInTheDocument();
    expect(bar("Write docs")).toHaveFocus();
  });

  it("moves the timeline selection with j and k from anywhere on the page", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const planned = { ...task(0, 1, "").milestones, plannedAt: new Date(2026, 5, 1).getTime() / 1000 };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage", { milestones: planned }),
        task(2, 1, "Add UI", { dependsOn: [1], milestones: planned }),
      ],
    });
    renderApp();
    const timeline = await screen.findByRole("region", { name: "Task timeline" }, { timeout: 5000 });
    await within(timeline).findByText("Add UI");
    const heading = async (title: string) =>
      within(await within(timeline).findByRole("complementary", { name: "Task details" })).findByRole("heading", {
        name: title,
      });

    fireEvent.keyDown(document.body, { key: "j" });
    expect(await heading("Add storage")).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "j" });
    expect(await heading("Add UI")).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "k" });
    expect(await heading("Add storage")).toBeInTheDocument();
  });

  it("keeps the timeline details open while its edit form has unsaved changes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const planned = { ...task(0, 1, "").milestones, plannedAt: new Date(2026, 5, 1).getTime() / 1000 };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [task(1, 1, "Add UI", { milestones: planned }), task(2, 1, "Write docs", { milestones: planned })],
    });
    await renderWorkspace();
    await taskList();
    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    const bar = (title: string) =>
      within(timeline.querySelector(".react-flow__nodes") as HTMLElement)
        .getByText(title)
        .closest(".react-flow__node") as HTMLElement;
    await within(timeline).findByText("Add UI");

    fireEvent.click(bar("Add UI"));
    const details = await within(timeline).findByRole("complementary", { name: "Task details" });
    await chooseAction(1, "Edit #1", details);
    const field = within(details).getByLabelText("Title of #1");
    fireEvent.change(field, { target: { value: "Add the UI" } });

    // Escape in a field belongs to the form, which asks about its changes; the sheet stays.
    fireEvent.keyDown(field, { key: "Escape" });
    const formConfirm = within(details).getByRole("group", { name: "Discard changes to #1" });
    expect(within(timeline).getByRole("complementary", { name: "Task details" })).toBeInTheDocument();
    fireEvent.click(within(formConfirm).getByRole("button", { name: "Keep editing" }));

    fireEvent.click(within(details).getByRole("button", { name: "Close details" }));
    const unsaved = within(details).getByRole("group", { name: "Unsaved changes" });
    fireEvent.click(bar("Write docs"));
    expect(within(details).getByLabelText("Title of #1")).toHaveValue("Add the UI");
    fireEvent.click(within(unsaved).getByRole("button", { name: "Keep editing" }));
    expect(within(details).queryByRole("group", { name: "Unsaved changes" })).not.toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(
      within(within(details).getByRole("group", { name: "Unsaved changes" })).getByRole("button", {
        name: "Discard changes",
      }),
    );
    await waitFor(() =>
      expect(within(timeline).queryByRole("complementary", { name: "Task details" })).not.toBeInTheDocument(),
    );
  });

  it("gathers tasks needing attention in the sidebar and shows one on the timeline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const plannedAt = new Date(2026, 5, 1).getTime() / 1000;
    const milestones = { ...task(0, 1, "").milestones, plannedAt, startedAt: plannedAt + 3600 };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage", { status: "in_progress", milestones }),
        task(2, 1, "Fix redirect", {
          status: "in_review",
          milestones,
        }),
        task(3, 1, "Add UI", {
          status: "in_progress",
          milestones,
          notes: [{ kind: "blocker", body: "Need an account", at: plannedAt + 7200 }],
        }),
        task(4, 1, "Write docs", { milestones: { ...milestones, startedAt: null } }),
      ],
    });
    renderApp();

    const attention = await screen.findByRole("region", { name: /Needs attention/ });
    const items = await within(attention).findAllByRole("listitem");
    expect(items.map((item) => [...item.querySelectorAll("[data-reason]")].map((reason) => reason.textContent))).toEqual(
      [["Blocker", "Stalled"], ["Stalled"]],
    );
    expect(items[0]).toHaveTextContent("#3Add UI");
    expect(items[1]).toHaveTextContent("#1Add storage");

    // The task shows even from the list view, with a filter hiding it.
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Status filter" })).getByRole("button", { name: "Blocked" }));
    expect(screen.queryByRole("region", { name: "Task timeline" })).not.toBeInTheDocument();
    fireEvent.click(within(items[1]).getByRole("button", { name: /Add storage/ }));
    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    const details = await within(timeline).findByRole("complementary", { name: "Task details" });
    expect(within(details).getByRole("heading", { name: "Add storage" })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Status filter" })).queryAllByRole("button", { pressed: true })).toHaveLength(0);
  });

  it("lists tasks in the timeline's order, oldest first, with done work folded away", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const day = (n: number) => new Date(2026, 5, n).getTime() / 1000;
    const milestones = (startedAt: number, extra: Partial<Task["milestones"]> = {}) => ({
      ...task(0, 1, "").milestones,
      plannedAt: day(1),
      startedAt,
      ...extra,
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Ship v1", { status: "done", resolution: "merged", milestones: milestones(day(2), { completedAt: day(3) }) }),
        task(2, 1, "Plan docs", { dependsOn: [3], milestones: { ...task(0, 1, "").milestones, plannedAt: day(1) } }),
        task(3, 1, "Build API", { status: "in_progress", milestones: milestones(day(4)) }),
        task(4, 1, "Fix crash", { status: "in_review", milestones: milestones(day(6), { reviewAt: day(7) }) }),
        task(5, 1, "Add search", { milestones: { ...task(0, 1, "").milestones, plannedAt: day(1) } }),
        task(6, 1, "Add UI", { status: "in_progress", milestones: milestones(day(5)) }),
      ],
    });
    await renderWorkspace();

    const tasks = await taskList();
    const titles = () =>
      within(within(tasks).getByRole("list", { name: "Task list" }))
        .getAllByRole("listitem")
        .map((item) => item.querySelector("[data-task-row] button")?.textContent);
    expect(titles()).toEqual(["Build API", "Add UI", "Fix crash", "Plan docs", "Add search"]);

    const done = within(tasks).getByRole("button", { name: "Done 1" });
    expect(done).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(done);
    expect(done).toHaveAttribute("aria-expanded", "true");
    expect(titles()).toEqual(["Ship v1", "Build API", "Add UI", "Fix crash", "Plan docs", "Add search"]);
  });
});
