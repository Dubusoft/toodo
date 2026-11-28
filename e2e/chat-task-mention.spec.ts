import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createTask } from "./server";

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("not shown");
  return { ...found, right: found.x + found.width, bottom: found.y + found.height };
}

async function openChat(app: Page) {
  await app.getByRole("button", { name: /^Open chat/ }).click();
  const chat = app.getByRole("dialog", { name: "Chat" });
  await expect(chat).toBeVisible();
  // The chat opens with an animation; measure it at rest.
  await expect.poll(async () => await chat.evaluate((element) => element.getAnimations().length)).toBe(0);
  return chat;
}

/** The input box around the composer's input, attach and send buttons, which the `#` menu opens above. */
function composer(input: Locator) {
  return input.locator("xpath=ancestor::div[contains(@class, 'rounded-2xl')][1]");
}

/** The menu opens just above the composer's input box, as wide as it, wherever the `#` is typed. */
async function expectAboveComposer(menu: Locator, input: Locator) {
  const shown = await box(menu);
  const target = await box(composer(input));
  expect(shown.bottom).toBeLessThanOrEqual(target.y);
  expect(shown.x).toBeCloseTo(target.x, 0);
  expect(shown.width).toBeCloseTo(target.width, 0);
}

/** The task numbers the `#` menu lists, in order. */
async function listedNumbers(menu: Locator) {
  const texts = await menu.getByRole("option").allTextContents();
  return texts.map((text) => Number(/^#(\d+)/.exec(text)?.[1]));
}

/** The composer's draft, with the trailing space a completion leaves. */
async function draft(input: Locator) {
  return (await input.evaluate((element) => element.textContent ?? "")).replace(/\u00a0/g, " ");
}

for (const { name, width, height } of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`completes a task number typed after # in the chat on ${name}`, async ({ app, server }, testInfo) => {
    await app.setViewportSize({ width, height });
    for (let index = 1; index <= 12; index += 1) await createTask(server, { workspaceId: 1, title: `Mention target ${index}` });
    await app.reload();
    const chat = await openChat(app);
    const input = chat.getByRole("combobox", { name: "Message input" });
    const menu = app.getByRole("listbox", { name: "Tasks" });

    await input.click();
    await app.keyboard.type("#");
    await expect(menu).toBeVisible();
    // The latest ten, newest first, with their titles and status, above the input.
    await expect.poll(() => listedNumbers(menu)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    await expect(menu.getByRole("option").first()).toContainText("Mention target 12");
    await expect(menu.getByRole("option").first()).toContainText("Ready");
    await expectAboveComposer(menu, input);
    expect((await box(menu)).x).toBeGreaterThanOrEqual(0);
    expect((await box(menu)).right).toBeLessThanOrEqual(width);
    await testInfo.attach(`# menu on ${name}`, { body: await app.screenshot(), contentType: "image/png" });

    // Digits keep the numbers starting with them, the number itself first.
    await app.keyboard.type("1");
    await expect.poll(() => listedNumbers(menu)).toEqual([1, 12, 11, 10]);
    await testInfo.attach(`#1 filtered on ${name}`, { body: await app.screenshot(), contentType: "image/png" });

    // Arrow keys and Enter complete the number.
    await app.keyboard.press("ArrowDown");
    await app.keyboard.press("Enter");
    await expect(menu).toBeHidden();
    await expect.poll(() => draft(input)).toBe("#12 ");

    // So does a click, and Tab.
    await app.keyboard.type("#11");
    await expect.poll(() => listedNumbers(menu)).toEqual([11]);
    await menu.getByRole("option").first().click();
    await expect.poll(() => draft(input)).toBe("#12 #11 ");
    await app.keyboard.type("#10");
    await expect.poll(() => listedNumbers(menu)).toEqual([10]);
    await app.keyboard.press("Tab");
    await expect.poll(() => draft(input)).toBe("#12 #11 #10 ");

    // Escape closes the menu and leaves the chat and the draft as they were.
    await app.keyboard.type("#");
    await expect(menu).toBeVisible();
    await app.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(chat).toBeVisible();
    await app.keyboard.press("Backspace");
    await expect.poll(() => draft(input)).toBe("#12 #11 #10 ");

    // With the menu closed, Enter sends the message.
    await app.keyboard.press("Enter");
    await expect(chat.getByText("#12 #11 #10", { exact: true })).toBeVisible();
    await expect.poll(() => draft(input)).toBe("");
    await testInfo.attach(`sent on ${name}`, { body: await app.screenshot(), contentType: "image/png" });
  });
}

test("completes a task number in a task's thread", async ({ app, server }, testInfo) => {
  await app.setViewportSize({ width: 1440, height: 900 });
  const task = await createTask(server, { workspaceId: 1, title: "Discuss the mention menu" });
  const other = await createTask(server, { workspaceId: 1, title: "Referenced from the thread" });
  // A lane at work on the task lists it, with its thread, under In progress.
  await server.mcp("start_task", { id: task.id, reason: "Working on it", refs: ["lane:mention-menu"] });
  await server.rpc("create_chat_thread", { thread: { channelId: 1, title: "Mention menu", taskId: task.id } });
  // Wide enough that the list shows beside the conversation.
  await app.evaluate(() => localStorage.setItem("toodo-panel-sizes", JSON.stringify({ "chat-width": 800 })));
  await app.reload();
  const chat = await openChat(app);
  await chat.getByRole("list", { name: "In progress" }).getByRole("button", { name: new RegExp(`^#${task.id} `) }).click();
  await expect(chat.getByRole("heading", { name: new RegExp(`^#${task.id} `) })).toBeVisible();
  const input = chat.getByRole("combobox", { name: "Message input" });
  const menu = app.getByRole("listbox", { name: "Tasks" });

  await input.click();
  // A # typed after other words still opens the menu over the whole input box.
  await app.keyboard.type(`See #${other.id}`);
  await expect.poll(() => listedNumbers(menu)).toEqual([other.id]);
  await expect(menu.getByRole("option").first()).toContainText(other.title);
  await expectAboveComposer(menu, input);
  await testInfo.attach("# menu in a task thread", { body: await app.screenshot(), contentType: "image/png" });
  await app.keyboard.press("Enter");
  await expect.poll(() => draft(input)).toBe(`See #${other.id} `);
  await app.keyboard.press("Enter");
  await expect(chat.getByText(`See #${other.id}`, { exact: true })).toBeVisible();
});
