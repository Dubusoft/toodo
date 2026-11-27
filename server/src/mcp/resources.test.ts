import { expect, test } from "bun:test";
import { taskId } from "../domain/model.ts";
import { parseUri } from "./resources.ts";

test("URIs name a task and reject removed run resources", () => {
  expect(parseUri("toodo://tasks/12")).toBe(taskId(12));
  expect(parseUri("toodo://tasks/12/runs")).toBeNull();
  for (const other of [
    "toodo://tasks/",
    "toodo://tasks//runs",
    "toodo://tasks/-1",
    "toodo://tasks/12/commits",
    "toodo://tasks/#12",
    "file:///tasks/12",
  ]) {
    expect(parseUri(other)).toBeNull();
  }
});
