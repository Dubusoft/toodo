import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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

describe("App: creating and editing tasks", () => {
  setUpApp();

  it("creates a task and reloads the task list", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    mocked.createTask.mockResolvedValue({ status: "ok", data: task(5, 1, "Write docs") });
    await renderWorkspace();

    await screen.findByText("No tasks in this workspace yet.");
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [task(5, 1, "Write docs")] });
    expect(screen.queryByRole("combobox", { name: "Task type" })).not.toBeInTheDocument();
    fireEvent.focusIn(screen.getByLabelText("Task title"));
    chooseOption(screen.getByRole("combobox", { name: "Task type" }), "Docs");
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Write docs" } });
    fireEvent.change(screen.getByLabelText("Estimate"), { target: { value: "x" } });
    expect(isDisabled(screen.getByRole("button", { name: "Add task" }))).toBe(true);
    fireEvent.change(screen.getByLabelText("Estimate"), { target: { value: "2.5" } });
    chooseOption(screen.getByRole("combobox", { name: "Estimate unit" }), "weeks");
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-11-01" } });
    fireEvent.change(screen.getByLabelText("Labels"), { target: { value: " q4, docs ,, q4" } });
    fireEvent.click(screen.getByLabelText("Autopilot"));
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    expect(await screen.findByText("Write docs")).toBeInTheDocument();
    expect(mocked.createTask).toHaveBeenCalledWith({
      workspaceId: 1,
      taskType: "docs",
      title: "Write docs",
      description: "",
      estimate: { unit: "weeks", amount: 2.5 },
      dueDate: "2026-11-01",
      labels: ["docs", "q4"],
      autopilot: true,
      criteria: [],
    });
    // The form closes once the task is added, and opens again empty.
    expect(screen.queryByLabelText("Estimate")).not.toBeInTheDocument();
    fireEvent.focusIn(screen.getByLabelText("Task title"));
    expect(screen.getByLabelText("Task title")).toHaveValue("");
    expect(screen.getByLabelText("Estimate")).toHaveValue("");
  });

  it("keeps the new task form to one line until it is used, and keeps its draft when closed", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    await renderWorkspace();

    const form = await screen.findByRole("form", { name: "New task" });
    const title = within(form).getByLabelText("Task title");
    expect(within(form).queryByLabelText("Description")).not.toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Add task" })).toBeInTheDocument();

    fireEvent.focusIn(title);
    fireEvent.change(title, { target: { value: "Plan the release" } });
    fireEvent.change(within(form).getByLabelText("Description"), { target: { value: "Notes" } });
    expect(within(form).getByText("Markdown supported")).toBeInTheDocument();
    fireEvent.keyDown(title, { key: "Escape" });
    expect(within(form).queryByLabelText("Description")).not.toBeInTheDocument();
    expect(title).toHaveValue("Plan the release");

    fireEvent.focusIn(title);
    expect(within(form).getByLabelText("Description")).toHaveValue("Notes");
    fireEvent.click(within(form).getByRole("button", { name: "Close New task" }));
    expect(within(form).queryByLabelText("Description")).not.toBeInTheDocument();
    expect(title).toHaveFocus();

    fireEvent.focusIn(title);
    fireEvent.click(screen.getByRole("heading", { name: "toodo" }));
    expect(within(form).queryByLabelText("Description")).not.toBeInTheDocument();
  });

  it("creates a task with completion criteria", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [] });
    mocked.createTask.mockResolvedValue({ status: "ok", data: task(5, 1, "Add search") });
    await renderWorkspace();

    await screen.findByText("No tasks in this workspace yet.");
    const form = screen.getByRole("form", { name: "New task" });
    fireEvent.focusIn(within(form).getByLabelText("Task title"));
    fireEvent.change(within(form).getByLabelText("Task title"), { target: { value: "Add search" } });
    const add = within(form).getByRole("button", { name: "Add criterion" });
    fireEvent.click(add);
    fireEvent.change(within(form).getByLabelText("Criterion 1 text"), { target: { value: " Docs reviewed " } });
    fireEvent.click(add);
    fireEvent.change(within(form).getByLabelText("Criterion 2 text"), { target: { value: "Tests pass" } });
    expect(within(form).queryByLabelText("Criterion 2 target")).not.toBeInTheDocument();
    chooseOption(within(form).getByRole("combobox", { name: "Criterion 2 kind" }), "URL responds");
    // A URL criterion cannot be added without an http(s) URL.
    expect(isDisabled(within(form).getByRole("button", { name: "Add task" }))).toBe(true);
    fireEvent.change(within(form).getByLabelText("Criterion 2 target"), { target: { value: "https://example.com/health" } });
    // A row left blank is not sent.
    fireEvent.click(add);
    fireEvent.click(within(form).getByRole("button", { name: "Add task" }));

    await waitFor(() => expect(within(form).queryByLabelText("Criterion 1 text")).not.toBeInTheDocument());
    expect(mocked.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Add search",
        criteria: [
          { text: "Docs reviewed", kind: "manual", target: null },
          { text: "Tests pass", kind: "url", target: "https://example.com/health" },
        ],
      }),
    );
  });

  it("adds and removes task dependencies", async () => {
    const storage = task(1, 1, "Add storage");
    const ui = task(2, 1, "Add UI");
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [storage, ui] });
    mocked.addDependency.mockResolvedValue({ status: "ok", data: "added" });
    await renderWorkspace();

    const details = await openDetails("Add UI");
    const add = within(details).getByRole("combobox", { name: "Add dependency to #2" });
    expect(within(openOptions(add)).getByRole("option", { name: "#1 Add storage" })).toBeInTheDocument();
    expect(within(openOptions(add)).queryByRole("option", { name: "#2 Add UI" })).not.toBeInTheDocument();
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [storage, { ...ui, status: "planned", dependsOn: [1] }],
    });
    chooseOption(add, "#1 Add storage");

    const remove = await within(details).findByRole("button", { name: "Remove dependency #1 from #2" });
    expect(mocked.addDependency).toHaveBeenCalledWith(2, 1, false);
    expect(isDisabled(within(details).getByRole("button", { name: "Start #2" }))).toBe(true);
    mocked.removeDependency.mockResolvedValue({ status: "ok", data: null });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [storage, ui] });
    fireEvent.click(remove);

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Remove dependency #1 from #2" })).not.toBeInTheDocument(),
    );
    expect(mocked.removeDependency).toHaveBeenCalledWith(2, 1);
  });

  it("does not offer a dependency that would close a cycle and shows why one was rejected", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage"),
        task(2, 1, "Add UI", { status: "planned", dependsOn: [1] }),
        task(3, 1, "Add docs", { status: "planned", dependsOn: [2] }),
        task(4, 1, "Add search"),
      ],
    });
    mocked.addDependency.mockResolvedValue({
      status: "error",
      error: { kind: "rejected", code: "rejected", message: "dependency would create a cycle: #1 -> #4 -> #1" },
    });
    await renderWorkspace();

    const details = await openDetails("Add storage");
    const add = within(details).getByRole("combobox", { name: "Add dependency to #1" });
    expect(within(openOptions(add)).queryByRole("option", { name: "#2 Add UI" })).not.toBeInTheDocument();
    expect(within(openOptions(add)).queryByRole("option", { name: "#3 Add docs" })).not.toBeInTheDocument();
    // The server checks the whole DAG, also edges the app has not loaded yet.
    chooseOption(add, "#4 Add search");

    expect(await findAlert()).toHaveTextContent("would create a cycle");
    expect(mocked.addDependency).toHaveBeenCalledWith(1, 4, false);
    expect(screen.queryByRole("combobox", { name: "Add dependency to #2" })).not.toBeInTheDocument();
  });

  it("edits the type, title, and description of a task", async () => {
    const original = task(1, 1, "Add login", {
      description: "old",
      estimate: { unit: "hours", amount: 3 },
      dueDate: "2026-11-01",
      labels: ["auth"],
    });
    const edited = { ...original, taskType: "fix" as const, title: "Add sign-in", description: "new" };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [original] });
    mocked.updateTask.mockResolvedValue({ status: "ok", data: edited });
    await renderWorkspace();

    await chooseAction(1, "Edit #1");
    const form = screen.getByRole("form", { name: "Edit task #1" });
    chooseOption(within(form).getByRole("combobox", { name: "Type of #1" }), "Fix");
    fireEvent.change(within(form).getByLabelText("Title of #1"), { target: { value: "  Add sign-in " } });
    fireEvent.change(within(form).getByLabelText("Description of #1"), { target: { value: " new " } });
    expect(within(form).getByLabelText("Estimate of #1")).toHaveValue("3");
    fireEvent.change(within(form).getByLabelText("Estimate of #1"), { target: { value: "" } });
    fireEvent.change(within(form).getByLabelText("Due date of #1"), { target: { value: "2026-12-01" } });
    expect(within(form).getByLabelText("Labels of #1")).toHaveValue("auth");
    fireEvent.change(within(form).getByLabelText("Labels of #1"), { target: { value: "q4, auth" } });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [edited] });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Add sign-in")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Edit task #1" })).not.toBeInTheDocument();
    expect(mocked.updateTask).toHaveBeenCalledWith({
      status: null,
      id: 1,
      taskType: "fix",
      title: "Add sign-in",
      description: "new",
      estimate: null,
      dueDate: "2026-12-01",
      labels: ["auth", "q4"],
      autopilot: null,
      criteria: null,
    });
  });

  it("turns autopilot on and off from the details sheet", async () => {
    const original = task(1, 1, "Add sign-in", { dueDate: "2026-12-01" });
    const marked = { ...original, autopilot: true, autopilotAt: 1_794_441_600 };
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [original] });
    mocked.updateTask.mockResolvedValue({ status: "ok", data: marked });
    await renderWorkspace();

    const sheet = await openDetails("Add sign-in");
    const toggle = await within(sheet).findByRole("button", { name: "Autopilot of #1" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [marked] });
    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    expect(mocked.updateTask).toHaveBeenLastCalledWith({
      status: null,
      id: 1,
      taskType: original.taskType,
      title: "Add sign-in",
      description: original.description,
      estimate: null,
      dueDate: "2026-12-01",
      autopilot: true,
      criteria: null,
    });

    mocked.listTasks.mockResolvedValue({ status: "ok", data: [original] });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));
    expect(mocked.updateTask).toHaveBeenLastCalledWith(expect.objectContaining({ id: 1, autopilot: false }));
  });

  it("marks tasks missing an estimate or due date and opens the edit form at the missing field", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add login", { dueDate: "2026-11-01" }),
        task(2, 1, "Add search", { estimate: { unit: "days", amount: 2 } }),
        task(3, 1, "Add export", { estimate: { unit: "hours", amount: 3 }, dueDate: "2026-11-01" }),
      ],
    });
    await renderWorkspace();

    const noEstimate = await screen.findByRole("button", { name: "Edit plan of #1: no estimate" });
    expect(noEstimate).toHaveTextContent("No estimate");
    expect(screen.getByRole("button", { name: "Edit plan of #2: no due date" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Edit plan of #3/ })).not.toBeInTheDocument();

    fireEvent.click(noEstimate);
    const form = screen.getByRole("form", { name: "Edit task #1" });
    expect(within(form).getByLabelText("Estimate of #1")).toHaveFocus();
    fireEvent.click(within(form).getByRole("button", { name: "Discard" }));

    fireEvent.click(screen.getByRole("button", { name: "Edit plan of #2: no due date" }));
    expect(within(screen.getByRole("form", { name: "Edit task #2" })).getByLabelText("Due date of #2")).toHaveFocus();
  });

  it("edits the criteria of a task and keeps the existing ones by ID", async () => {
    const original = task(1, 1, "Add search", {
      criteria: [
        criterion(3, "Health check answers", { kind: "url", target: "https://example.com/health" }),
        criterion(4, "Docs reviewed"),
      ],
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [original] });
    mocked.updateTask.mockResolvedValue({ status: "ok", data: original });
    await renderWorkspace();

    await chooseAction(1, "Edit #1");
    const form = screen.getByRole("form", { name: "Edit task #1" });
    fireEvent.change(within(form).getByLabelText("Criterion 2 text of #1"), {
      target: { value: "Docs and changelog reviewed" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add criterion to #1" }));
    fireEvent.change(within(form).getByLabelText("Criterion 3 text of #1"), { target: { value: "Search answers" } });
    chooseOption(within(form).getByRole("combobox", { name: "Criterion 3 kind of #1" }), "URL responds");
    fireEvent.change(within(form).getByLabelText("Criterion 3 target of #1"), {
      target: { value: "https://example.com/search" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("form", { name: "Edit task #1" })).not.toBeInTheDocument());
    expect(mocked.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        criteria: [
          { id: 3, text: "Health check answers", kind: "url", target: "https://example.com/health" },
          { id: 4, text: "Docs and changelog reviewed", kind: "manual", target: null },
          { text: "Search answers", kind: "url", target: "https://example.com/search" },
        ],
      }),
    );
  });

  it("asks before discarding unsaved edits of a task", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [task(1, 1, "Add login")] });
    await renderWorkspace();

    await chooseAction(1, "Edit #1");
    const form = screen.getByRole("form", { name: "Edit task #1" });
    const title = within(form).getByLabelText("Title of #1");
    await waitFor(() => expect(title).toHaveFocus());
    fireEvent.click(within(form).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("form", { name: "Edit task #1" })).not.toBeInTheDocument();

    await chooseAction(1, "Edit #1");
    const changed = screen.getByRole("form", { name: "Edit task #1" });
    fireEvent.change(within(changed).getByLabelText("Title of #1"), { target: { value: "Add sign-in" } });
    fireEvent.keyDown(within(changed).getByLabelText("Title of #1"), { key: "Escape" });
    const confirm = within(changed).getByRole("group", { name: "Discard changes to #1" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep editing" }));
    expect(within(changed).getByLabelText("Title of #1")).toHaveValue("Add sign-in");

    fireEvent.click(within(changed).getByRole("button", { name: "Discard" }));
    fireEvent.click(within(changed).getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("form", { name: "Edit task #1" })).not.toBeInTheDocument();
    expect(mocked.updateTask).not.toHaveBeenCalled();
  });

  it("closes inline forms on Escape and asks before discarding what was typed", async () => {
    const started = task(1, 1, "Try a new cache", {
      status: "in_progress",
    });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    const finished = task(2, 1, "Add storage", { status: "done", resolution: "merged" });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [started, finished] });
    await renderWorkspace();

    fireEvent.click(await within(await taskList()).findByRole("button", { name: "Done 1" }));
    // The details sheet keeps the note mounted while its form is closed.
    const details = await openDetails("Add storage");
    await chooseAction(2, "Add completion note to #2", details);
    fireEvent.change(screen.getByLabelText("Completion note for #2"), { target: { value: "Shipped" } });
    fireEvent.keyDown(screen.getByLabelText("Completion note for #2"), { key: "Escape" });
    fireEvent.click(
      within(screen.getByRole("group", { name: "Discard note of #2" })).getByRole("button", {
        name: "Discard changes",
      }),
    );
    expect(screen.queryByRole("form", { name: "Completion note form of #2" })).not.toBeInTheDocument();
    // Opened again, the form starts out empty instead of asking.
    await chooseAction(2, "Add completion note to #2", details);
    expect(screen.getByLabelText("Completion note for #2")).toHaveValue("");
    expect(screen.queryByRole("group", { name: "Discard note of #2" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("Completion note for #2"), { key: "Escape" });
    expect(screen.queryByRole("form", { name: "Completion note form of #2" })).not.toBeInTheDocument();

    await chooseAction(1, "Conclude #1 without completing");
    const conclusion = screen.getByRole("textbox", { name: "Conclusion of #1" });
    fireEvent.change(conclusion, { target: { value: "Twice as slow" } });
    fireEvent.keyDown(conclusion, { key: "Escape" });
    const question = screen.getByRole("group", { name: "Discard conclusion of #1" });
    expect(within(question).getByRole("button", { name: "Keep editing" })).toHaveFocus();
    // A second Escape goes back to the form with the text kept.
    fireEvent.keyDown(within(question).getByRole("button", { name: "Keep editing" }), { key: "Escape" });
    expect(screen.getByRole("textbox", { name: "Conclusion of #1" })).toHaveValue("Twice as slow");
    expect(screen.getByRole("textbox", { name: "Conclusion of #1" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("form", { name: "Conclude #1" })).not.toBeInTheDocument();
    expect(mocked.concludeTask).not.toHaveBeenCalled();
  });

  it("previews a Markdown description and shows its plain text in the list", async () => {
    const original = task(1, 1, "Add login", { description: "## Steps\n\n- [x] **form**" });
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({ status: "ok", data: [original] });
    await renderWorkspace();

    // The row previews the first paragraph; the heading above it is left out.
    await within(await taskList()).findByRole("button", { name: "Add login" });
    expect(within(row("Add login")).getByText("form")).toBeInTheDocument();
    expect(within(row("Add login")).queryByText(/Steps/)).not.toBeInTheDocument();
    await chooseAction(1, "Edit #1");
    const form = screen.getByRole("form", { name: "Edit task #1" });
    fireEvent.click(within(form).getByRole("radio", { name: "Preview" }));

    const preview = within(form).getByRole("region", { name: "Preview of Description of #1" });
    expect(await within(preview).findByRole("heading", { name: "Steps" })).toBeInTheDocument();
    expect(within(preview).getByRole("img", { name: "Done" })).toBeInTheDocument();
    expect(within(form).queryByLabelText("Description of #1")).not.toBeInTheDocument();
    fireEvent.click(within(form).getByRole("radio", { name: "Write" }));
    expect(within(form).getByLabelText("Description of #1")).toHaveValue("## Steps\n\n- [x] **form**");
  });

  it("shows related tasks in the details sheet and links and unlinks them", async () => {
    mocked.listWorkspaces.mockResolvedValue({ status: "ok", data: [toodo] });
    mocked.listTasks.mockResolvedValue({
      status: "ok",
      data: [
        task(1, 1, "Add storage"),
        task(2, 1, "Add UI"),
        task(3, 1, "Write docs"),
      ],
    });
    let relations = [{ taskId: 1, relatedId: 2 }];
    mocked.listTaskRelations.mockImplementation(async () => ({
      status: "ok",
      data: structuredClone(relations),
    }));
    mocked.addTaskRelation.mockImplementation(
      async (taskId: number, relatedId: number) => {
        relations = [
          ...relations,
          {
            taskId: Math.min(taskId, relatedId),
            relatedId: Math.max(taskId, relatedId),
          },
        ];
        return { status: "ok", data: null };
      },
    );
    mocked.removeTaskRelation.mockImplementation(
      async (taskId: number, relatedId: number) => {
        relations = relations.filter(
          (relation) =>
            relation.taskId !== Math.min(taskId, relatedId) ||
            relation.relatedId !== Math.max(taskId, relatedId),
        );
        return { status: "ok", data: null };
      },
    );
    renderApp();

    const timeline = await screen.findByRole("region", {
      name: "Task timeline",
    });
    const bar = async (title: string) =>
      (
        await within(
          timeline.querySelector(".react-flow__nodes") as HTMLElement,
        ).findByText(title)
      ).closest(".react-flow__node") as HTMLElement;
    fireEvent.click(await bar("Add storage"));
    const details = await within(timeline).findByRole("complementary", {
      name: "Task details",
    });
    const related = await within(details).findByRole("list", {
      name: "Related tasks of #1",
    });
    expect(within(related).getAllByRole("listitem")).toHaveLength(1);

    // A chip opens the related task in the sheet.
    fireEvent.click(
      within(related).getByRole("button", { name: "Open related task #2" }),
    );
    expect(
      await within(details).findByRole("heading", { name: "Add UI" }),
    ).toBeInTheDocument();
    // The link shows from both ends, and a task without links has no Related field.
    expect(
      await within(details).findByRole("list", { name: "Related tasks of #2" }),
    ).toBeInTheDocument();

    fireEvent.click(await bar("Write docs"));
    expect(
      await within(details).findByRole("heading", { name: "Write docs" }),
    ).toBeInTheDocument();
    expect(
      within(details).queryByRole("region", { name: "Related" }),
    ).not.toBeInTheDocument();
    chooseOption(within(details).getByRole("combobox", { name: "Add related task to #3" }), "#1 Add storage");
    await waitFor(() =>
      expect(mocked.addTaskRelation).toHaveBeenCalledWith(3, 1),
    );
    const added = await within(details).findByRole("list", {
      name: "Related tasks of #3",
    });
    fireEvent.click(
      within(added).getByRole("button", {
        name: "Remove related task #1 from #3",
      }),
    );
    await waitFor(() =>
      expect(mocked.removeTaskRelation).toHaveBeenCalledWith(3, 1),
    );
    await waitFor(() =>
      expect(
        within(details).queryByRole("list", { name: "Related tasks of #3" }),
      ).not.toBeInTheDocument(),
    );
  });
});
