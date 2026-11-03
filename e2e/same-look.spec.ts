import { expect, test } from "./fixtures";
import { createTask } from "./server";

test("edits a task through a labelled pencil action", async ({ app, server }) => {
  const task = await createTask(server, { workspaceId: 1, title: "Tidy the settings page" });
  await app.reload();

  await app.getByRole("button", { name: /^alpha/ }).click();
  await app.getByRole("button", { name: `More actions for #${task.id}` }).click();
  const taskEdit = app.getByRole("menuitem", { name: `Edit #${task.id}` });
  await expect(taskEdit).toHaveText("Edit");
  await expect(taskEdit.locator("svg.lucide-pencil")).toHaveCount(1);
  await app.keyboard.press("Escape");
});

test("gives the backup actions one style and names the restore of a file", async ({ app }) => {
  await app.getByRole("button", { name: /^Settings/ }).click();
  await app.getByRole("tab", { name: "Backups" }).click();
  // The server writes a backup each time it starts.
  const backup = app.getByRole("list", { name: "Saved backups" }).getByRole("listitem").first();
  const download = backup.getByRole("button", { name: /^Download backup from/ });
  const restore = backup.getByRole("button", { name: /^Restore this backup from/ });

  await expect(restore).toHaveText("Restore this backup");
  expect(await download.getAttribute("class")).toBe(await restore.getAttribute("class"));
});

test("shows Clone, Open and Init in the sidebar as outlined buttons", async ({ app }) => {
  for (const mode of ["Clone", "Open", "Init"]) {
    const button = app.getByRole("button", { name: `${mode} on Local` });
    await expect(button).toHaveCSS("border-top-width", "1px");
    await expect(button).not.toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  }
});
