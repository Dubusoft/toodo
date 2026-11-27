// The texts the MCP server gives agents: the `initialize` instructions, the skill
// `read_toodo_skill` returns (`toodo-skill.md`), and the shorter instructions chat apps
// connected over OAuth get. Rules they share are kept once in `shared/` and put where a
// template says `{{name}}`.

const MCP_DIR = new URL("./", import.meta.url);

const read = (path: string) => Bun.file(new URL(path, MCP_DIR)).text();

const SHARED: ReadonlyArray<readonly [string, string]> = await Promise.all(
  ["completion", "other-tasks", "task-description", "review-timing", "merge-policy", "guidelines"].map(
    async (name) => [name, await read(`shared/${name}.md`)] as const,
  ),
);

/** `template` with every `{{name}}` replaced by the shared fragment `name`, without its
 * trailing whitespace. */
export function render(template: string): string {
  return SHARED.reduce((text, [name, fragment]) => text.split(`{{${name}}}`).join(fragment.trimEnd()), template);
}

const INSTRUCTIONS_TEMPLATE =
  "Toodo records tasks, dependencies, notes, references, and status history. Read read_toodo_skill before managing tasks.\n\n{{guidelines}}\n\nCall current_task with ref to find a task by one of its refs, or get_task with id. Call list_workspaces and search_tasks before creating work; reuse matching records and read related tasks for context.\n\nDependencies point from task_id to the prerequisite ids in depends_on. Reject cycles, complete prerequisites first, and use related links for context that does not block work. Adding an unfinished prerequisite pauses active work; resume_task when it becomes ready.\n\n{{task-description}}\n\n{{other-tasks}}\n\n{{completion}}\n\n{{review-timing}}\n\n{{merge-policy}}";

const CHAT_TEMPLATE =
  "Plan tasks and record progress, decisions and blockers in Toodo. Use list_workspaces, search_tasks and get_task before creating records. {{task-description}} {{guidelines}}";

/** The instructions `initialize` and `server/discover` return. */
export const INSTRUCTIONS = render(INSTRUCTIONS_TEMPLATE);

/** The skill `read_toodo_skill` returns. */
export const SKILL = render(await read("toodo-skill.md"));

/** The instructions for chat apps connected over OAuth, which `read_toodo_skill` returns to
 * them too. */
export const CHAT_INSTRUCTIONS = render(CHAT_TEMPLATE);
