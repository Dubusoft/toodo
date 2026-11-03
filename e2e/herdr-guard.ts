import { execFileSync } from "node:child_process";

/** The ids of the workspaces herdr has open, or `null` when herdr is not running here. */
function openWorkspaces(): Set<string> | null {
  try {
    const reply = JSON.parse(execFileSync("herdr", ["workspace", "list"], { encoding: "utf8", timeout: 10_000 }));
    return new Set((reply.result.workspaces as { workspace_id: string }[]).map((workspace) => workspace.workspace_id));
  } catch {
    return null;
  }
}

/**
 * Scratch servers must never touch the herdr of the machine running the tests. This fails
 * the run when it leaves a workspace open in herdr that was not open before it.
 */
export default function guardHerdr() {
  const before = openWorkspaces();
  return () => {
    const after = openWorkspaces();
    if (!before || !after) return;
    const left = [...after].filter((id) => !before.has(id));
    if (left.length > 0) {
      throw new Error(`The test run left ${left.length} new herdr workspace(s) open: ${left.join(", ")}`);
    }
  };
}
