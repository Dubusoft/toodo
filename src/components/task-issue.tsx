import type { Task } from "@/lib/bindings";
import { DetailField } from "@/components/task-common";

/** The GitHub issue linked to a task. */
export function TaskIssue({ task }: { task: Task }) {
  const issue = task.issue;
  if (issue === null) return null;
  return (
    <DetailField label="Issue">
      <p className="flex min-w-0 items-center gap-1 text-xs">
        <span aria-label={`Issue of #${task.id}`} title={issue.url} className="shrink-0 font-medium tabular-nums">
          #{issue.number}
        </span>
        <span className="min-w-0 break-all font-mono text-muted-foreground select-all">{issue.url}</span>
      </p>
    </DetailField>
  );
}
