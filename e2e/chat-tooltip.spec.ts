import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("not shown");
  return { ...found, right: found.x + found.width, bottom: found.y + found.height };
}

type Box = Awaited<ReturnType<typeof box>>;
const overlaps = (a: Box, b: Box) => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;

const titles = [
  "Plan the migration of every workspace to the new storage layout",
  "Review the notification settings for channels and threads on every device",
  "Collect the feedback on the resizable chat from the last two weeks",
];

test.use({ viewport: { width: 1440, height: 900 } });

test("shows a cut chat list title beside its item, so the items above and below stay in reach", async ({
  app,
  server,
}, testInfo) => {
  for (const title of titles) await server.rpc("create_chat_thread", { thread: { channelId: 1, title, taskId: null } });
  // Wide enough that the list shows beside the conversation.
  await app.evaluate(() => localStorage.setItem("toodo-panel-sizes", JSON.stringify({ "chat-width": 800 })));
  await app.reload();
  await app.getByRole("button", { name: /^Open chat/ }).click();
  const chat = app.getByRole("dialog", { name: "Chat" });
  await expect.poll(async () => await chat.evaluate((element) => element.getAnimations().length)).toBe(0);
  const list = chat.getByRole("list", { name: "Threads in #general" });
  const items = list.getByRole("button");
  await expect(items).toHaveCount(titles.length);

  const item = items.nth(1);
  const at = await box(item);
  await app.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  const tooltip = app.getByRole("tooltip");
  await expect(tooltip).toHaveText((await item.textContent()) ?? "");
  await expect.poll(async () => await tooltip.evaluate((element) => element.getAnimations().length)).toBe(0);
  const tip = await box(tooltip);
  // Beside the item, level with it, and over no item of the list.
  expect(tip.right).toBeLessThanOrEqual(at.x);
  expect(tip.y).toBeLessThan(at.bottom);
  expect(tip.bottom).toBeGreaterThan(at.y);
  for (const other of await items.all()) expect(overlaps(tip, await box(other))).toBe(false);
  await testInfo.attach("tooltip beside the item", { body: await app.screenshot(), contentType: "image/png" });

  // Straight up onto the item above: the pointer reaches it, and its own tooltip replaces this one.
  const above = items.nth(0);
  const aboveTitle = (await above.textContent()) ?? "";
  const target = await box(above);
  expect(target.bottom).toBeLessThanOrEqual(at.y);
  const x = at.x + at.width / 2;
  const y = target.y + target.height / 2;
  await app.mouse.move(x, y, { steps: 8 });
  const hit = await list.evaluate(
    (element, [px, py]) => element.ownerDocument.elementFromPoint(px, py)?.closest("button")?.textContent ?? null,
    [x, y],
  );
  expect(hit).toBe(aboveTitle);
  await expect(tooltip).toHaveText(aboveTitle);
  await testInfo.attach("tooltip of the item above", { body: await app.screenshot(), contentType: "image/png" });
});
