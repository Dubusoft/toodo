import { Suspense } from "react";
import type { NoteKind, Task } from "@/lib/bindings";
import { formatFull } from "@/lib/timeline";
import { When } from "@/components/when";
import { markdownPreview } from "@/lib/markdown";
import { toneChip, type Tone } from "@/lib/status-styles";
import { cn } from "@/lib/utils";
import { DetailField, Markdown } from "@/components/task-common";

const noteKindLabels: Record<NoteKind, string> = { progress: "Progress", blocker: "Blocker", decision: "Decision" };
const noteKindTones: Record<NoteKind, Tone> = { progress: "neutral", blocker: "attention", decision: "info" };

function NoteKindBadge({ kind }: { kind: NoteKind }) {
  return (
    <span
      data-note-kind={kind}
      className={cn(
        "shrink-0 rounded-md px-1.5 font-medium",
        toneChip[noteKindTones[kind]],
      )}
    >
      {noteKindLabels[kind]}
    </span>
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
