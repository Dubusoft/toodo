import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createTask, type ScratchServer } from "./server";

const taskCount = 30;

async function seedTasks(server: ScratchServer) {
  const ids: number[] = [];
  for (let n = 1; n <= taskCount; n += 1) {
    ids.push((await createTask(server, { workspaceId: 1, taskType: "chore", title: `Timeline row ${n}` })).id);
  }
  return ids;
}

function bar(page: Page, id: number): Locator {
  return page.locator(`.react-flow__nodes .react-flow__node[data-id="${id}"]`);
}

async function openTimeline(page: Page) {
  await page.getByRole("button", { name: "All workspaces" }).click();
  await expect(page.getByRole("region", { name: "Task timeline" })).toBeVisible();
}

for (const scale of ["Day", "Week"]) {
  test(`${scale} timeline opens at the first row with Now at the left edge`, async ({ app, server }) => {
    const ids = await seedTasks(server);
    await app.reload();
    await openTimeline(app);
    await app.getByRole("button", { name: scale, exact: true }).click();
    await expect(app.getByRole("button", { name: scale, exact: true })).toHaveAttribute("aria-pressed", "true");

    const canvas = app.locator(".react-flow");
    const now = app.getByText(/^Now \d\d:\d\d$/);
    const last = bar(app, ids[ids.length - 1]);
    const first = bar(app, ids[0]);

    await expect(first).toBeVisible();

    await expect
      .poll(async () => {
        const [area, line, row] = await Promise.all([canvas.boundingBox(), now.boundingBox(), first.boundingBox()]);
        if (!area || !line || !row) return null;
        return {
          nowAtLeftEdge: line.x - area.x >= 14 && line.x - area.x <= 22,
          firstRowInside: row.y >= area.y && row.y + row.height <= area.y + area.height,
          firstRowAtTop: row.y - area.y < 80,
        };
      })
      .toEqual({ nowAtLeftEdge: true, firstRowInside: true, firstRowAtTop: true });

    const [area, bottom] = await Promise.all([canvas.boundingBox(), last.boundingBox()]);
    expect(bottom!.y).toBeGreaterThan(area!.y + area!.height);
  });
}

test("autopilot tasks carry the bot icon of the Autopilot filter", async ({ app, server }) => {
  const autopilot = await createTask(server, { workspaceId: 1, title: "Taken up by an executor", autopilot: true });
  const manual = await createTask(server, { workspaceId: 1, title: "Done by hand" });
  await app.reload();
  await openTimeline(app);

  await expect(bar(app, autopilot.id).getByRole("img", { name: `#${autopilot.id} is marked for autopilot` })).toBeVisible();
  await expect(bar(app, manual.id)).toBeVisible();
  await expect(bar(app, manual.id).locator("svg.lucide-bot")).toHaveCount(0);

  const filter = app.getByRole("button", { name: "Autopilot", exact: true });
  await expect(filter.locator("svg.lucide-bot")).toHaveCount(1);
  await filter.click();
  await expect(filter).toHaveAttribute("aria-pressed", "true");
  await expect(filter.locator("svg.lucide-bot")).toHaveCount(1);
  await expect(bar(app, manual.id)).toHaveCount(0);
});

test("selecting a bar dims the tasks it does not depend on or lead to", async ({ app, server }) => {
  const [before, middle, after, apart] = await Promise.all(
    ["Before", "Middle", "After", "Apart"].map((title) => createTask(server, { workspaceId: 1, title })),
  );
  await server.rpc("add_dependency", { taskId: middle.id, dependsOn: before.id, confirmPause: false });
  await server.rpc("add_dependency", { taskId: after.id, dependsOn: middle.id, confirmPause: false });
  await app.reload();
  await openTimeline(app);

  await bar(app, middle.id).click();

  await expect(app.getByRole("complementary", { name: "Task details" })).toBeVisible();
  await expect(bar(app, apart.id).locator("[data-dimmed]")).toHaveCount(1);
  await expect(bar(app, before.id).locator("[data-dimmed]")).toHaveCount(0);
  await expect(bar(app, after.id).locator("[data-dimmed]")).toHaveCount(0);
});
