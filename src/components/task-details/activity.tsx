import { useI18n, useMessages } from "@/lib/i18n";
import { Suspense } from "react";
import type { NoteKind, Task } from "@/lib/bindings";
import { formatFull } from "@/lib/timeline";
import { When } from "@/components/when";
import { markdownPreview } from "@/lib/markdown";
import { serverText } from "@/lib/server-text";
import { Badge, type BadgeProps } from "@astryxdesign/core/Badge";
import { DetailField, Markdown } from "@/components/task-common";

const noteKindVariants: Record<NoteKind, BadgeProps["variant"]> = {
  progress: "neutral",
  blocker: "warning",
  decision: "info",
};

function NoteKindBadge({ kind }: { kind: NoteKind }) {
  const m = useMessages();
  return (
    <Badge data-note-kind={kind} className="shrink-0" variant={noteKindVariants[kind]} label={m.details.noteKinds[kind]} />
  );
}

/**
 * Notes agents left on the task through the MCP server: all of them in the details sheet,
 * the latest one in a list row.
 */
export function TaskNotes({ task, detailed }: { task: Task; detailed: boolean }) {
  const { locale, m } = useI18n();
  const notes = task.notes;
  if (notes.length === 0) {
    return null;
  }
  if (!detailed) {
    const latest = notes[notes.length - 1];
    return (
      <p
        aria-label={m.details.notes.latest(task.id)}
        className="flex min-w-0 items-center gap-1.5 text-xs"
        title={formatFull(latest.at, locale)}
      >
        <NoteKindBadge kind={latest.kind} />
        <span className="min-w-0 truncate text-muted-foreground">{markdownPreview(serverText(latest.body, m, locale))}</span>
        {notes.length > 1 && (
          <span className="shrink-0 text-muted-foreground">{m.details.notes.more(notes.length - 1)}</span>
        )}
      </p>
    );
  }
  return (
    <DetailField label={m.details.notes.count(notes.length)}>
      <ol aria-label={m.details.notes.ofTask(task.id)} className="flex flex-col gap-2">
        {notes.map((note, index) => (
          <li key={index} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <NoteKindBadge kind={note.kind} />
              <When className="text-muted-foreground" at={note.at} />
            </div>
            <Suspense fallback={<p className="whitespace-pre-line break-words-keep">{serverText(note.body, m, locale)}</p>}>
              <Markdown source={serverText(note.body, m, locale)} />
            </Suspense>
          </li>
        ))}
      </ol>
    </DetailField>
  );
}
