import { expect, test } from "bun:test";
import { ArgumentError, numbersFromStrings } from "./args.ts";
import TOOL_LIST from "./tools.json" with { type: "json" };

type Schema = Record<string, unknown>;
const TOOLS = TOOL_LIST as Array<{ name: string; inputSchema: Schema }>;

function schemaOf(tool: string): Schema {
  const found = TOOLS.find((entry) => entry.name === tool);
  if (found === undefined) throw new Error(`no tool ${tool}`);
  return found.inputSchema;
}

/** `args` converted for `tool`, or the message it is rejected with. */
function convert(tool: string, args: Schema): Schema | string {
  try {
    return numbersFromStrings(schemaOf(tool), args);
  } catch (error) {
    if (error instanceof ArgumentError) return error.message;
    throw error;
  }
}

test("Every integer argument takes a numeric string", () => {
  const checked: string[] = [];
  for (const tool of TOOLS) {
    const properties = tool.inputSchema.properties as Record<string, Schema> | undefined;
    for (const name of Object.keys(properties ?? {})) {
      const converted = (value: unknown) => {
        const result = convert(tool.name, { [name]: value });
        return typeof result === "string" ? result : result[name];
      };
      const asNumber = converted("12");
      if (asNumber === 12) {
        expect(converted(12)).toBe(12);
        for (const given of ["abc", "1.5", "", " 12", "#12", "-1"]) {
          expect(converted(given)).toStartWith(`${name} must be a whole number`);
        }
      } else if (Array.isArray(converted(["3", 4])) && (converted(["3", 4]) as unknown[])[0] === 3) {
        expect(converted(["3", 4])).toEqual([3, 4]);
        expect(converted([3, "x"])).toStartWith(`${name}[1] must be`);
      } else {
        continue;
      }
      checked.push(`${tool.name}.${name}`);
    }
  }
  for (const argument of [
    "get_task.id",
    "list_tasks.workspace_id",
    "create_task.workspace_id",
    "create_task.depends_on",
    "check_criterion.task_id",
    "check_criterion.criterion_id",
    "add_related.related_id",
    "add_dependency.depends_on",
    "remove_dependency.depends_on",
  ]) {
    expect(checked).toContain(argument);
  }
});

test("Nested IDs take numeric strings", () => {
  expect(convert("update_task", { id: "7", criteria: [{ id: "11" }, { text: "12", kind: "manual" }] })).toEqual({
    id: 7,
    criteria: [{ id: 11 }, { text: "12", kind: "manual" }],
  });
  expect(convert("create_plan", { tasks: [{ key: "a", workspace_id: "1", depends_on: ["3"], related: ["4"] }] })).toEqual({
    tasks: [{ key: "a", workspace_id: 1, depends_on: [3], related: [4] }],
  });
  expect(convert("update_task", { id: 7, criteria: [{ id: 11 }, { id: "1.5" }] })).toStartWith(
    'criteria[1].id must be a whole number such as 12 or "12", not "1.5"',
  );
});

test("Aliased criterion IDs take numeric strings", () => {
  expect(convert("check_criterion", { criterion_id: "3" })).toEqual({ criterion_id: 3 });
  expect(convert("check_criterion", { id: "3" })).toEqual({ id: 3 });
  expect(convert("remove_criterion", { id: "3" })).toEqual({ id: 3 });
  expect(convert("remove_criterion", { id: "x" })).toStartWith("id must be a whole number");
});

test("ID arguments advertise numeric strings", () => {
  const properties = (tool: string) => schemaOf(tool).properties as Record<string, Schema>;
  expect(properties("get_task").id).toEqual({
    type: ["integer", "string"],
    pattern: "^[0-9]+$",
    description: "The task, e.g. one that search_tasks found.",
  });
  expect(properties("check_criterion").task_id.type).toEqual(["integer", "string", "null"]);
});
