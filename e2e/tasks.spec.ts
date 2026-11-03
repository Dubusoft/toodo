import { expect, test } from "./fixtures";
import { createTask } from "./server";

test("creates a task in a workspace", async ({ app }) => {
  await app.getByRole("button", { name: /^alpha/ }).click();

  // The form rests as one line and opens once its title field takes focus.
  await expect(app.getByLabel("Task type")).toHaveCount(0);
  await app.getByLabel("Task title").fill("Repair the login redirect");
  await app.getByLabel("Task type").selectOption("fix");
  await app.getByRole("button", { name: "Add task" }).click();

  const row = app.getByRole("region", { name: "Tasks" }).getByRole("listitem").filter({ hasText: "Repair the login redirect" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("fix");
  await expect(app.getByLabel("Task title")).toHaveValue("");
});

test("edits the title of a task and keeps it after a reload", async ({ app, server }) => {
  const task = await createTask(server, { workspaceId: 1, title: "Draft the release notes" });
  await app.reload();
  await app.getByRole("button", { name: /^alpha/ }).click();

  await app.getByRole("button", { name: `More actions for #${task.id}` }).click();
  await app.getByRole("menuitem", { name: `Edit #${task.id}` }).click();
  const title = app.getByLabel(`Title of #${task.id}`);
  await title.fill("Write the release notes");
  await app.getByRole("form", { name: `Edit task #${task.id}` }).getByRole("button", { name: "Save" }).click();

  const tasks = app.getByRole("region", { name: "Tasks" });
  await expect(tasks.getByText("Write the release notes")).toBeVisible();
  await expect(tasks.getByText("Draft the release notes")).toHaveCount(0);

  await app.reload();
  await app.getByRole("button", { name: /^alpha/ }).click();
  await expect(app.getByRole("region", { name: "Tasks" }).getByText("Write the release notes")).toBeVisible();
});

test("adds and removes a dependency", async ({ app, server }) => {
  const first = await createTask(server, { workspaceId: 1, title: "Build the parser" });
  const second = await createTask(server, { workspaceId: 1, title: "Wire the parser into the importer" });
  await app.reload();
  await app.getByRole("button", { name: /^alpha/ }).click();

  // Dependencies are edited in the task's details sheet, opened from its title.
  await app.getByRole("region", { name: "Tasks" }).getByRole("button", { name: second.title }).click();
  const details = app.getByRole("complementary", { name: "Task details" });
  await details.getByLabel(`Add dependency to #${second.id}`).selectOption({ label: `#${first.id} ${first.title}` });

  const dependencies = details.getByRole("group", { name: `Dependencies of #${second.id}` });
  await expect(dependencies).toContainText(`#${first.id}`);
  await expect(app.getByRole("region", { name: "Tasks" }).getByRole("note", { name: `Waiting prerequisites of #${second.id}` })).toContainText(`#${first.id}`);

  await details.getByRole("button", { name: `Remove dependency #${first.id} from #${second.id}` }).click();
  await expect(dependencies.getByRole("button", { name: /^Remove dependency/ })).toHaveCount(0);
});

test("rejects a dependency that would close a cycle", async ({ server }) => {
  const first = await createTask(server, { workspaceId: 1, title: "First" });
  const second = await createTask(server, { workspaceId: 1, title: "Second" });
  await server.rpc("add_dependency", { taskId: second.id, dependsOn: first.id, confirmPause: false });

  await expect(server.rpc("add_dependency", { taskId: first.id, dependsOn: second.id, confirmPause: false })).rejects.toThrow(/cycle/i);
});

test("links related tasks both ways for agents", async ({ server }) => {
  const tool = await createTask(server, { workspaceId: 1, title: "Parser tool" });
  const research = await createTask(server, { workspaceId: 2, title: "Parser research" });

  await server.mcp("add_related", { task_id: tool.id, related_id: research.id });

  const fromTool = await server.mcp<{ related: { id: number }[] }>("get_task", { id: tool.id });
  const fromResearch = await server.mcp<{ related: { id: number }[] }>("get_task", { id: research.id });
  expect(fromTool.related.map((link) => link.id)).toEqual([research.id]);
  expect(fromResearch.related.map((link) => link.id)).toEqual([tool.id]);

  await server.mcp("remove_related", { task_id: research.id, related_id: tool.id });
  const after = await server.mcp<{ related: unknown[] }>("get_task", { id: tool.id });
  expect(after.related).toEqual([]);
});
