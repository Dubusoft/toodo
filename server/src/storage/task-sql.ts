/** The condition on tasks aliased t that neither the task nor its workspace is archived. */
export const LIVE_TASK = `(t.archived_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM workspaces aw WHERE aw.id = t.workspace_id AND aw.archived_at IS NOT NULL))`;

/** The condition on edges aliased d that their prerequisite is live. */
export const LIVE_PREREQUISITE = `NOT EXISTS (
  SELECT 1 FROM tasks p JOIN workspaces pw ON pw.id = p.workspace_id
  WHERE p.id = d.depends_on_id AND (p.archived_at IS NOT NULL OR pw.archived_at IS NOT NULL))`;

export type TaskFilter = {
  readonly condition: string;
  readonly parameters: readonly number[];
};
