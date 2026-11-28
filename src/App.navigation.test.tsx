import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  chooseOption,
  goBack,
  herdr,
  mocked,
  openDetails,
  renderApp,
  renderWorkspace,
  setUpApp,
  task,
  taskList,
  toodo,
} from "@/test/app";

describe("App: search, command palette, and navigation", () => {
  setUpApp();

  it("searches tasks and filters them by status and type in every task view", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const plannedAt = new Date(2026, 5, 1).getTime() / 1000;
    const planned = { ...task(0, 1, "").milestones, plannedAt };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage", { description: "SQLite schema", milestones: planned }),
        task(2, 1, "Fix login", { taskType: "fix", status: "in_progress", milestones: planned }),
        task(3, 2, "Fix ssh", { taskType: "fix", milestones: planned }),
      ],
    });
    await renderWorkspace();

    const tasks = await taskList();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "sqlite" } });
    expect(within(tasks).getByText("Add storage")).toBeInTheDocument();
    expect(within(tasks).queryByText("Fix login")).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Status filter" })).getByRole("button", { name: "In progress" }));
    expect(await screen.findByText("No tasks match the search and filters.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(within(screen.getByRole("region", { name: "Tasks" })).getAllByRole("listitem")).toHaveLength(2);
    // Selected statuses add up: Ready alone, then Ready and In progress together.
    const statusFilter = screen.getByRole("group", { name: "Status filter" });
    fireEvent.click(within(statusFilter).getByRole("button", { name: "Ready" }));
    expect(within(screen.getByRole("region", { name: "Tasks" })).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(within(statusFilter).getByRole("button", { name: "In progress" }));
    expect(within(screen.getByRole("region", { name: "Tasks" })).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    expect(await within(timeline).findByText("Add storage")).toBeInTheDocument();
    chooseOption(screen.getByRole("combobox", { name: "Type filter" }), "Fix");
    expect(await within(timeline).findByText("Fix ssh")).toBeInTheDocument();
    expect(within(timeline).getByText("Fix login")).toBeInTheDocument();
    expect(within(timeline).queryByText("Add storage")).not.toBeInTheDocument();

    // The filters stay when switching to the list of every workspace.
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "SSH" } });
    const all = screen.getByRole("region", { name: "Tasks" });
    expect(within(all).getAllByRole("listitem")).toHaveLength(1);
    expect(within(all).getByText("Fix ssh")).toBeInTheDocument();
  });

  it("finds a task by its number in any workspace, first, with the text matches", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage"),
        task(2, 1, "Follow up on 3", { status: "in_progress" }),
        task(3, 2, "Fix ssh"),
      ],
    });
    await renderWorkspace();

    const tasks = await taskList();
    const search = screen.getByRole("searchbox", { name: "Search tasks" });
    fireEvent.change(search, { target: { value: "#3" } });
    const match = within(tasks).getByRole("list", { name: "Task number match" });
    expect(within(match).getByText("Fix ssh")).toBeInTheDocument();
    expect(within(match).getByText("herdr")).toBeInTheDocument();
    expect(within(tasks).getAllByRole("listitem")).toHaveLength(1);

    fireEvent.change(search, { target: { value: "3" } });
    const rows = within(tasks).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-task-row"))).toEqual(["3", "2"]);

    fireEvent.click(within(screen.getByRole("group", { name: "Status filter" })).getByRole("button", { name: "In progress" }));
    expect(within(tasks).queryByRole("list", { name: "Task number match" })).not.toBeInTheDocument();
    expect(within(tasks).getByText("Follow up on 3")).toBeInTheDocument();
  });

  it("loads a finished task older than the loaded pages when a search names its number", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    const old = task(3, 1, "Old storage work", { status: "done", resolution: "completed" });
    mocked.listTasks.mockImplementation(async (filter) => ({
      status: "ok",
      data: filter?.ids ? [old].filter((entry) => filter.ids?.includes(entry.id)) : filter?.statuses?.includes("planned") ? [task(9, 1, "Add search")] : [],
    }));
    await renderWorkspace();

    const tasks = await taskList();
    expect(within(tasks).queryByText("Old storage work")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "#3" } });
    const match = await screen.findByRole("list", { name: "Task number match" });
    expect(within(match).getByText("Old storage work")).toBeInTheDocument();
    expect(mocked.listTasks).toHaveBeenCalledWith({ ids: [3] });
  });

  it("shows a finished task found by ID on the timeline even outside the selected year", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const milestones = task(0, 1, "").milestones;
    const old = task(1747, 1, "Old storage work", {
      status: "done",
      resolution: "completed",
      milestones: {
        ...milestones,
        plannedAt: new Date(2025, 5, 1).getTime() / 1000,
        startedAt: new Date(2025, 5, 1).getTime() / 1000,
        completedAt: new Date(2025, 5, 2).getTime() / 1000,
      },
    });
    const current = task(9, 1, "Follow up on #1747", {
      milestones: { ...milestones, plannedAt: new Date(2026, 5, 1).getTime() / 1000 },
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockImplementation(async (filter) => ({
      status: "ok",
      data: filter?.ids?.includes(old.id) ? [old] : filter?.statuses?.includes("planned") ? [current] : [],
    }));
    renderApp();
    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    chooseOption(within(timeline).getByRole("combobox", { name: "Timeline period" }), "2026");
    const statuses = screen.getByRole("group", { name: "Status filter" });
    fireEvent.click(within(statuses).getByRole("button", { name: "Done" }));
    const search = screen.getByRole("searchbox", { name: "Search tasks" });

    fireEvent.change(search, { target: { value: "#1747" } });

    expect(await screen.findByText("Old storage work")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "1747" } });
    expect(screen.getByText("Old storage work")).toBeInTheDocument();
    fireEvent.click(within(statuses).getByRole("button", { name: "Done" }));
    expect(screen.queryByText("Old storage work")).not.toBeInTheDocument();
  });

  it("jumps to a task and runs actions from the command palette opened with Ctrl+K or Cmd+K", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [task(1, 1, "Add storage"), task(2, 2, "Ship pane events")],
    });
    await renderWorkspace();
    await taskList();

    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: "Command palette" });
    const search = within(palette).getByRole("combobox", { name: "Search actions and tasks" });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "#2" } });
    // The first match is highlighted, so Enter runs it.
    const highlighted = (field: HTMLElement) => document.getElementById(field.getAttribute("aria-activedescendant") ?? "");
    await waitFor(() => expect(highlighted(search)).toHaveTextContent("#2 Ship pane events"));
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "herdr" })).toBeInTheDocument();
    const details = await screen.findByRole("complementary", { name: "Task details" });
    expect(within(details).getByText("Ship pane events")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    const again = screen.getByRole("combobox", { name: "Search actions and tasks" });
    fireEvent.change(again, { target: { value: "show review" } });
    await waitFor(() => expect(highlighted(again)).toHaveTextContent("Show the review"));
    fireEvent.keyDown(again, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Review" })).toHaveAttribute("aria-pressed", "true");

    // Escape closes the palette without running anything.
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search actions and tasks" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
  });

  it("moves between tasks with j and k and opens their details without the mouse, but not while typing", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [task(1, 1, "Add storage"), task(2, 1, "Add UI"), task(3, 1, "Write docs")],
    });
    await renderWorkspace();
    const list = await taskList();
    const titles = () => [...list.querySelectorAll<HTMLElement>("[data-task-title]")];
    await waitFor(() => expect(titles()).toHaveLength(3));
    const [first, second, third] = titles();

    fireEvent.keyDown(document.body, { key: "j" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "j" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "j" });
    fireEvent.keyDown(third, { key: "k" });
    expect(second).toHaveFocus();

    // Enter on the focused title presses it, which opens the details; j then shows the next task's.
    fireEvent.click(second);
    const details = await screen.findByRole("complementary", { name: "Task details" });
    expect(within(details).getByText(second.textContent!)).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "j" });
    expect(await within(details).findByText(third.textContent!)).toBeInTheDocument();
    expect(third).toHaveFocus();

    // Typed into a field, the letters stay text.
    const searchField = screen.getByRole("searchbox", { name: "Search tasks" });
    searchField.focus();
    fireEvent.keyDown(searchField, { key: "k" });
    fireEvent.keyDown(searchField, { key: "?" });
    expect(searchField).toHaveFocus();
    expect(within(details).getByText(third.textContent!)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();

    third.focus();
    fireEvent.keyDown(third, { key: "/" });
    expect(searchField).toHaveFocus();
    searchField.blur();
    fireEvent.keyDown(document.body, { key: "?" });
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveTextContent("Open the command palette");
  });

  it("starts on All workspaces and keeps the timeline scale and task drafts while navigating", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo, herdr] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [task(1, 1, "Add storage"), task(3, 2, "Fix ssh")] });
    renderApp();

    expect(await screen.findByRole("heading", { name: "All workspaces" })).toBeInTheDocument();
    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    fireEvent.click(within(timeline).getByRole("button", { name: "Day" }));

    fireEvent.click(screen.getByRole("button", { name: /^toodo/ }));
    fireEvent.focusIn(await screen.findByLabelText("Task title"));
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Half-written task" } });
    chooseOption(screen.getByRole("combobox", { name: "Task type" }), "Fix");
    fireEvent.click(screen.getByRole("button", { name: /^herdr/ }));
    expect(await screen.findByRole("heading", { name: "herdr" })).toBeInTheDocument();
    expect(screen.getByLabelText("Task title")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: /^toodo/ }));
    expect(await screen.findByLabelText("Task title")).toHaveValue("Half-written task");
    fireEvent.focusIn(screen.getByLabelText("Task title"));
    expect(screen.getByRole("combobox", { name: "Task type" })).toHaveTextContent("Fix");

    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    expect(
      within(await screen.findByRole("region", { name: "Task timeline" })).getByRole("button", { name: "Day" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    expect(
      within(await screen.findByRole("region", { name: "Task timeline" })).getByRole("button", { name: "Day" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("opens the phone menu as a modal drawer and returns focus when it closes", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    await renderWorkspace();

    const open = screen.getByRole("button", { name: "Open menu" });
    fireEvent.click(open);
    const menu = screen.getByRole("dialog", { name: "Menu" });
    expect(menu).toHaveAttribute("aria-modal", "true");
    expect(within(menu).getByRole("button", { name: "Close menu" })).toHaveFocus();
    expect(open.closest("[inert]")).not.toBeNull();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument();
    expect(open.closest("[inert]")).toBeNull();
    expect(open).toHaveFocus();
  });

  it("opens the task a clicked notification asks for and keeps it in the address", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15));
    const plannedAt = new Date(2026, 5, 1).getTime() / 1000;
    const milestones = { ...task(0, 1, "").milestones, plannedAt, startedAt: plannedAt + 3600 };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage", { status: "in_progress", milestones }),
        task(2, 1, "Fix redirect", { status: "in_progress", milestones }),
      ],
    });
    window.history.replaceState(null, "", "/?task=2");

    renderApp();

    const timeline = await screen.findByRole("region", { name: "Task timeline" });
    const details = await within(timeline).findByRole("complementary", { name: "Task details" });
    expect(within(details).getByRole("heading", { name: "Fix redirect" })).toBeInTheDocument();
    expect(window.location.search).toBe("?task=2");
  });

  it("keeps the workspace, view, and selected task in the address for back, forward, and reload", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [task(1, 1, "Add storage"), task(2, 1, "Fix redirect")],
    });
    const { unmount } = renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /^toodo/ }, { timeout: 5000 }));
    expect(window.location.search).toBe("?workspace=1");
    let details = await openDetails("Fix redirect");
    expect(window.location.search).toBe("?workspace=1&task=2");
    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    fireEvent.click(await screen.findByRole("button", { name: "List" }));
    expect(window.location.search).toBe("?view=list");

    // Back returns to the All workspaces timeline, then to the workspace with its task open.
    await goBack();
    expect(window.location.search).toBe("");
    expect(await screen.findByRole("button", { name: "Timeline", pressed: true })).toBeInTheDocument();
    await goBack();
    details = await screen.findByRole("complementary", { name: "Task details" });
    expect(within(details).getByRole("heading", { name: "Fix redirect" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "toodo" })).toBeInTheDocument();

    // A reload, or the copied address opened anew, shows the same workspace and task.
    unmount();
    renderApp();
    details = await screen.findByRole("complementary", { name: "Task details" });
    expect(within(details).getByRole("heading", { name: "Fix redirect" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "toodo" })).toBeInTheDocument();
  });
});
