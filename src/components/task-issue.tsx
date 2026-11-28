import { useMessages } from "@/lib/i18n";
import type { Task } from "@/lib/bindings";
import { DetailField } from "@/components/task-common";

/** The GitHub issue linked to a task. */
export function TaskIssue({ task }: { task: Task }) {
  const m = useMessages();
  const issue = task.issue;
  if (issue === null) return null;
  return (
    <DetailField label={m.details.fields.issue}>
      <p className="flex min-w-0 items-center gap-1 text-xs">
        <span aria-label={m.details.fields.issueOf(task.id)} title={issue.url} className="shrink-0 font-medium tabular-nums">
          #{issue.number}
        </span>
        <span className="min-w-0 break-all font-mono text-muted-foreground select-all">{issue.url}</span>
      </p>
    </DetailField>
  );
}
