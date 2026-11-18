import { Suspense } from "react";
import type { NoteKind, Task } from "@/lib/bindings";
import { formatFull } from "@/lib/timeline";
import { When } from "@/components/when";
import { markdownPreview } from "@/lib/markdown";
import { Badge, type BadgeProps } from "@astryxdesign/core/Badge";
import { DetailField, Markdown } from "@/components/task-common";

const noteKindLabels: Record<NoteKind, string> = { progress: "Progress", blocker: "Blocker", decision: "Decision" };
const noteKindVariants: Record<NoteKind, BadgeProps["variant"]> = {
  progress: "neutral",
  blocker: "warning",
  decision: "info",
};

function NoteKindBadge({ kind }: { kind: NoteKind }) {
  return (
    <Badge data-note-kind={kind} className="shrink-0" variant={noteKindVariants[kind]} label={noteKindLabels[kind]} />
  );
}

/**
 * Notes agents left on the task through the MCP server: all of them in the details sheet,
 * the latest one in a list row.
 */
export function TaskNotes({ task, detailed }: { task: Task; detailed: boolean }) {
  const notes = task.notes;
  if (notes.length === 0) {
    return null;
  }
  if (!detailed) {
    const latest = notes[notes.length - 1];
    return (
      <p
        aria-label={`Latest note of #${task.id}`}
        className="flex min-w-0 items-center gap-1.5 text-xs"
        title={formatFull(latest.at)}
      >
        <NoteKindBadge kind={latest.kind} />
        <span className="min-w-0 truncate text-muted-foreground">{markdownPreview(latest.body)}</span>
        {notes.length > 1 && (
          <span className="shrink-0 text-muted-foreground">{`+${notes.length - 1} more`}</span>
        )}
      </p>
    );
  }
  return (
    <DetailField label={`Notes (${notes.length})`}>
      <ol aria-label={`Notes of #${task.id}`} className="flex flex-col gap-2">
        {notes.map((note, index) => (
          <li key={index} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <NoteKindBadge kind={note.kind} />
              <When className="text-muted-foreground" at={note.at} />
            </div>
            <Suspense fallback={<p className="whitespace-pre-line break-words-keep">{note.body}</p>}>
              <Markdown source={note.body} />
            </Suspense>
          </li>
        ))}
      </ol>
    </DetailField>
  );
}
