import { expect, test } from "bun:test";
import { CHAT_INSTRUCTIONS, INSTRUCTIONS, SKILL } from "./instructions.ts";

const SHARED = new URL("./shared/", import.meta.url);
const fragment = async (name: string) => (await Bun.file(new URL(`${name}.md`, SHARED)).text()).trimEnd();

test("The instructions and the skill share each fragment", async () => {
  for (const text of [SKILL, INSTRUCTIONS, CHAT_INSTRUCTIONS]) expect(text).not.toContain("{{");
  for (const name of ["completion", "other-tasks", "task-description", "review-timing", "merge-policy", "guidelines"]) {
    const shared = await fragment(name);
    expect(SKILL).toContain(shared);
    expect(INSTRUCTIONS).toContain(shared);
  }
  expect(CHAT_INSTRUCTIONS).toContain(await fragment("task-description"));
  expect(CHAT_INSTRUCTIONS).toContain(await fragment("guidelines"));
});
