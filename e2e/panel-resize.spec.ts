import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createTask } from "./server";

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("not shown");
  return { ...found, right: found.x + found.width, bottom: found.y + found.height };
}

async function drag(page: Page, handle: Locator, dx: number, dy = 0) {
  const { x, y, width, height } = await box(handle);
  await page.mouse.move(x + width / 2, y + height / 2);
  await page.mouse.down();
  await page.mouse.move(x + width / 2 + dx / 2, y + height / 2 + dy / 2);
  await page.mouse.move(x + width / 2 + dx, y + height / 2 + dy);
  await page.mouse.up();
}

async function openBoth(app: Page, title: string) {
  await app.getByRole("button", { name: /^alpha/ }).click();
  await app.getByRole("region", { name: "Tasks" }).getByRole("button", { name: title }).click();
  await app.getByRole("button", { name: /^Open chat/ }).click();
  const chat = app.getByRole("dialog", { name: "Chat" });
  const details = app.getByRole("complementary", { name: "Task details" });
  await expect(chat).toBeVisible();
  await expect(details).toBeVisible();
  // The chat opens with an animation; measure it at rest.
  await expect.poll(async () => (await chat.evaluate((element) => element.getAnimations().length))).toBe(0);
  return { chat, details };
}

test.use({ viewport: { width: 1440, height: 900 } });

test("resizes the chat and the details on desktop, keeps them docked, and remembers the sizes", async ({ app, server }) => {
  const task = await createTask(server, { workspaceId: 1, title: "Tune the chat layout" });
  await app.reload();
  const { chat, details } = await openBoth(app, task.title);
  const before = { chat: await box(chat), details: await box(details) };

  await drag(app, chat.getByRole("separator", { name: "Resize the chat", exact: true }), -80);
  const widened = { chat: await box(chat), details: await box(details) };
  expect(widened.chat.width).toBeCloseTo(before.chat.width + 80, 0);
  expect(widened.chat.right).toBeCloseTo(before.chat.right, 0);
  expect(widened.chat.bottom).toBeCloseTo(before.chat.bottom, 0);
  // The details follow, still just left of the chat.
  expect(widened.chat.x - widened.details.right).toBeCloseTo(before.chat.x - before.details.right, 0);

  await drag(app, details.getByRole("separator", { name: "Resize the task details" }), -40);
  const grown = await box(details);
  expect(grown.width).toBeCloseTo(widened.details.width + 40, 0);
  expect(grown.right).toBeCloseTo(widened.details.right, 0);

  await drag(app, chat.getByRole("separator", { name: "Resize the chat's height" }), 0, -80);
  const taller = await box(chat);
  expect(taller.height).toBeCloseTo(widened.chat.height + 80, 0);
  expect(taller.bottom).toBeCloseTo(before.chat.bottom, 0);

  await app.reload();
  const again = await openBoth(app, task.title);
  expect((await box(again.chat)).width).toBeCloseTo(widened.chat.width, 0);
  expect((await box(again.chat)).height).toBeCloseTo(taller.height, 0);
  expect((await box(again.details)).width).toBeCloseTo(grown.width, 0);
});

test("resizes the chat's width and height together from its top-left corner and remembers both", async ({ app, server }) => {
  const task = await createTask(server, { workspaceId: 1, title: "Stretch the chat diagonally" });
  await app.reload();
  const { chat, details } = await openBoth(app, task.title);
  const before = { chat: await box(chat), details: await box(details) };
  const corner = chat.getByRole("separator", { name: "Resize the chat's width and height" });
  await expect(corner).toHaveCSS("cursor", "nwse-resize");

  await drag(app, corner, -80, -60);
  const after = { chat: await box(chat), details: await box(details) };
  expect(after.chat.width).toBeCloseTo(before.chat.width + 80, 0);
  expect(after.chat.height).toBeCloseTo(before.chat.height + 60, 0);
  expect(after.chat.right).toBeCloseTo(before.chat.right, 0);
  expect(after.chat.bottom).toBeCloseTo(before.chat.bottom, 0);
  expect(after.chat.x - after.details.right).toBeCloseTo(before.chat.x - before.details.right, 0);

  await app.reload();
  const again = await openBoth(app, task.title);
  expect((await box(again.chat)).width).toBeCloseTo(after.chat.width, 0);
  expect((await box(again.chat)).height).toBeCloseTo(after.chat.height, 0);
});

test("keeps both panels on screen and part of the list in view however far they are dragged", async ({ app, server }) => {
  const task = await createTask(server, { workspaceId: 1, title: "Stretch the panels" });
  await app.reload();
  const { chat, details } = await openBoth(app, task.title);

  await drag(app, chat.getByRole("separator", { name: "Resize the chat", exact: true }), -2000);
  await drag(app, details.getByRole("separator", { name: "Resize the task details" }), -2000);
  await drag(app, chat.getByRole("separator", { name: "Resize the chat's height" }), 0, -2000);
  await drag(app, chat.getByRole("separator", { name: "Resize the chat's width and height" }), -2000, -2000);
  const stretched = { chat: await box(chat), details: await box(details) };
  // The sidebar is 16rem wide; past it at least 12rem of the list stays in view.
  expect(stretched.details.x).toBeGreaterThanOrEqual(448);
  expect(stretched.chat.y).toBeGreaterThanOrEqual(0);
  expect(stretched.chat.right).toBeLessThanOrEqual(1440);

  // Dragging back moves the edge at once, with no dead stretch past the limit.
  await drag(app, chat.getByRole("separator", { name: "Resize the chat", exact: true }), 50);
  expect((await box(chat)).width).toBeCloseTo(stretched.chat.width - 50, 0);
});

for (const viewport of [
  { width: 900, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`leaves the panels at their default sizes at ${viewport.width}px wide`, async ({ app, server }) => {
    const task = await createTask(server, { workspaceId: 1, title: "Check the tablet layout" });
    await app.evaluate(() =>
      localStorage.setItem("toodo-panel-sizes", JSON.stringify({ "chat-width": 900, "chat-beside-width": 700, "details-width": 700 })),
    );
    await app.setViewportSize(viewport);
    await app.reload();
    if (viewport.width < 768) await app.getByRole("button", { name: "Open menu" }).click();
    await app.getByRole("button", { name: /^alpha/ }).click();
    await app.getByRole("region", { name: "Tasks" }).getByRole("button", { name: task.title }).click();
    const details = app.getByRole("complementary", { name: "Task details" });
    await expect(details).toBeVisible();
    await expect(details.getByRole("separator", { name: "Resize the task details" })).toBeHidden();
    if (viewport.width >= 768) {
      await app.getByRole("button", { name: /^Open chat/ }).click();
      const chat = app.getByRole("dialog", { name: "Chat" });
      await expect(chat).toBeVisible();
      await expect(chat.getByRole("separator", { name: "Resize the chat's width and height" })).toBeHidden();
    }
    const expected = viewport.width >= 768 ? Math.min(480, Math.max(360, viewport.width * 0.4), viewport.width - 32) : viewport.width;
    expect((await box(details)).width).toBeCloseTo(expected, 0);
  });
}
