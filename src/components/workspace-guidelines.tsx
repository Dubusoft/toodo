import { Suspense, useId, useState, type FormEvent } from "react";
import { ChevronDown, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { compactSelectClass, escapeCloses, inputClass } from "@/components/workspace-list";
import { DiscardConfirm, useDiscardGuard } from "@/components/discard-guard";
import { Markdown } from "@/components/task-common";
import type { Guideline, GuidelineKind, Workspace } from "@/lib/bindings";
import { useAddGuideline, useDeleteGuideline, useGuidelines, useUpdateGuideline } from "@/lib/queries";
import { cn } from "@/lib/utils";

/** The most characters the server keeps in a guideline body, after trimming. */
const bodyLimit = 4000;

const kinds: GuidelineKind[] = ["rule", "memory"];

const kindNames: Record<GuidelineKind, string> = { rule: "Rule", memory: "Memory" };

const groupNames: Record<GuidelineKind, string> = { rule: "Rules", memory: "Memory" };

/** What each kind is for, shown next to the kind picker. */
const kindHints: Record<GuidelineKind, string> = {
  rule: "Agents must follow it.",
  memory: "A lesson or fact worth keeping for this workspace.",
};

/**
 * The guidelines of a workspace, which agents read before working on one of its tasks: rules
 * the owner sets for them, then memory, the lessons and facts recorded for the workspace.
 * Folded to their counts while there are any, so the tasks stay in view, and unfolded while
 * there are none, to say what they are for. Folding only hides them: open forms keep their text.
 */
export function WorkspaceGuidelines({ workspace }: { workspace: Workspace }) {
  const guidelines = useGuidelines(workspace.id);
  const addGuideline = useAddGuideline();
  // Null until the user folds or unfolds the guidelines.
  const [shown, setShown] = useState<boolean | null>(null);
  const [adding, setAdding] = useState(false);
  // The Add button takes the focus back once the form it opened closes.
  const [refocusAdd, setRefocusAdd] = useState(false);
  const panel = useId();
  const entries = guidelines.data ?? [];
  const rules = entries.filter((entry) => entry.kind === "rule");
  const memory = entries.filter((entry) => entry.kind === "memory");
  const expanded = shown ?? guidelines.data?.length === 0;
  const summary = [
    rules.length > 0 && `${rules.length} ${rules.length === 1 ? "rule" : "rules"}`,
    memory.length > 0 && `${memory.length} ${memory.length === 1 ? "memory" : "memories"}`,
  ]
    .filter(Boolean)
    .join(", ");

  function openAdd() {
    addGuideline.reset();
    setShown(true);
    setAdding(true);
  }

  function closeAdd() {
    setAdding(false);
    setRefocusAdd(true);
  }

  return (
    <section aria-label="Guidelines" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-medium text-muted-foreground">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={panel}
            className="flex items-center gap-1.5 rounded-sm text-left outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 max-md:min-h-11"
            onClick={() => setShown(!expanded)}
          >
            <ChevronDown aria-hidden className={cn("size-4 shrink-0 transition-transform", !expanded && "-rotate-90")} />
            Guidelines {summary && <span className="font-normal tabular-nums">{summary}</span>}
          </button>
        </h3>
        {!adding && (
          <Button
            size="xs"
            variant="outline"
            aria-label="Add guideline"
            title="Add a rule or memory for agents"
            autoFocus={refocusAdd}
            onClick={openAdd}
          >
            <Plus />
            Add
          </Button>
        )}
      </div>
      {guidelines.isError && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
          <p>Failed to load guidelines: {guidelines.error.message}</p>
          <Button size="xs" variant="outline" onClick={() => void guidelines.refetch()}>
            Retry now
          </Button>
        </div>
      )}
      <div id={panel} hidden={!expanded} className="flex flex-col gap-2">
        {guidelines.isPending && <p className="text-xs text-muted-foreground">Loading guidelines...</p>}
        {guidelines.data?.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No rules or memory yet; agents read them before working on a task in this workspace.
          </p>
        )}
        <GuidelineGroup kind="rule" entries={rules} />
        <GuidelineGroup kind="memory" entries={memory} />
        {adding && (
          <GuidelineForm
            label="Add guideline"
            className="rounded-xl border bg-card p-2.5"
            pending={addGuideline.isPending}
            error={addGuideline.error}
            onSave={(kind, body) =>
              addGuideline.mutate({ workspaceId: workspace.id, kind, body }, { onSuccess: closeAdd })
            }
            onClose={closeAdd}
          />
        )}
      </div>
    </section>
  );
}

/** The guidelines of one kind, in the order they were added; nothing while there are none. */
function GuidelineGroup({ kind, entries }: { kind: GuidelineKind; entries: Guideline[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-xs font-medium text-muted-foreground">{groupNames[kind]}</h4>
      <ul aria-label={groupNames[kind]} className="flex flex-col divide-y rounded-xl border bg-card">
        {entries.map((entry, index) => (
          <GuidelineItem key={entry.id} guideline={entry} position={index + 1} />
        ))}
      </ul>
    </div>
  );
}

/**
 * A guideline as Markdown, with buttons that edit it in place and delete it once confirmed.
 * The button that opened a form or question takes the focus back when it closes.
 */
function GuidelineItem({ guideline, position }: { guideline: Guideline; position: number }) {
  const updateGuideline = useUpdateGuideline();
  const deleteGuideline = useDeleteGuideline();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [refocus, setRefocus] = useState<"edit" | "delete" | null>(null);
  // "rule 2" in the names of its buttons, "Rule 2" as its own.
  const name = `${guideline.kind} ${position}`;
  const label = `${kindNames[guideline.kind]} ${position}`;

  function stopEditing() {
    setEditing(false);
    setRefocus("edit");
  }

  function stopConfirming() {
    setConfirming(false);
    setRefocus("delete");
  }

  if (editing) {
    return (
      <li aria-label={label} className="px-2.5 py-2">
        <GuidelineForm
          label={`Edit ${name}`}
          guideline={guideline}
          pending={updateGuideline.isPending}
          error={updateGuideline.error}
          onSave={(kind, body) =>
            updateGuideline.mutate({ id: guideline.id, kind, body }, { onSuccess: stopEditing })
          }
          onClose={stopEditing}
        />
      </li>
    );
  }

  return (
    <li aria-label={label} className="group/guideline flex flex-col gap-1.5 px-2.5 py-1.5">
      <div className="flex items-start gap-2">
        <Suspense
          fallback={<p className="min-w-0 flex-1 whitespace-pre-wrap break-words-keep text-sm">{guideline.body}</p>}
        >
          <Markdown source={guideline.body} className="flex-1 text-foreground" />
        </Suspense>
        {!confirming && (
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/guideline:opacity-100 group-hover/guideline:opacity-100 max-md:gap-2 [@media(hover:none)]:opacity-100">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Edit ${name}`}
              title="Edit"
              autoFocus={refocus === "edit"}
              onClick={() => {
                updateGuideline.reset();
                setEditing(true);
              }}
            >
              <Pencil />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Delete ${name}`}
              title="Delete"
              className="hover:text-destructive"
              autoFocus={refocus === "delete"}
              onClick={() => {
                deleteGuideline.reset();
                setConfirming(true);
              }}
            >
              <Trash2 />
            </Button>
          </div>
        )}
      </div>
      {confirming && (
        <div
          role="group"
          aria-label={`Delete ${name}?`}
          className="flex flex-wrap items-center gap-1 text-xs max-md:gap-2"
          onKeyDown={escapeCloses(stopConfirming, deleteGuideline.isPending)}
        >
          <span className="mr-1">Delete this {guideline.kind}? It cannot be restored.</span>
          <Button
            changesData
            size="xs"
            variant="destructive"
            aria-label={`Confirm delete ${name}`}
            disabled={deleteGuideline.isPending}
            onClick={() => deleteGuideline.mutate(guideline.id)}
          >
            <Trash2 />
            {deleteGuideline.isPending ? "Deleting..." : "Delete"}
          </Button>
          <Button size="xs" variant="ghost" autoFocus onClick={stopConfirming}>
            Back
          </Button>
        </div>
      )}
      {deleteGuideline.isError && (
        <p role="alert" className="text-xs text-destructive">
          {deleteGuideline.error.message}
        </p>
      )}
    </li>
  );
}

/**
 * The kind and Markdown body of a new guideline, or of `guideline` while it is edited. The body
 * is saved trimmed; closing the form with typed changes asks first, and so does Escape.
 */
function GuidelineForm({
  label,
  guideline,
  className,
  pending,
  error,
  onSave,
  onClose,
}: {
  label: string;
  guideline?: Guideline;
  className?: string;
  pending: boolean;
  error: Error | null;
  onSave: (kind: GuidelineKind, body: string) => void;
  onClose: () => void;
}) {
  const initialKind = guideline?.kind ?? "rule";
  const initialBody = guideline?.body ?? "";
  const [kind, setKind] = useState<GuidelineKind>(initialKind);
  const [body, setBody] = useState(initialBody);
  const hint = useId();
  const guard = useDiscardGuard(kind !== initialKind || body !== initialBody, onClose, pending);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(kind, body.trim());
  }

  return (
    <form
      aria-label={label}
      className={cn("flex flex-col gap-1.5", className)}
      onSubmit={submit}
      onKeyDown={guard.onKeyDown}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <select
          aria-label="Kind"
          aria-describedby={hint}
          className={compactSelectClass}
          value={kind}
          onChange={(e) => setKind(e.target.value as GuidelineKind)}
        >
          {kinds.map((option) => (
            <option key={option} value={option}>
              {kindNames[option]}
            </option>
          ))}
        </select>
        <span id={hint} className="text-xs text-muted-foreground">
          {kindHints[kind]}
        </span>
      </div>
      <textarea
        aria-label="Guideline"
        placeholder="Write it in Markdown"
        className={cn(inputClass, "h-24 py-1.5 max-md:h-32")}
        value={body}
        maxLength={bodyLimit}
        required
        autoFocus
        onChange={(e) => setBody(e.target.value)}
      />
      {guard.asking ? (
        <DiscardConfirm
          label={guideline ? "Discard guideline changes" : "Discard new guideline"}
          question={guideline ? "Discard the changes to the guideline?" : "Discard the new guideline?"}
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      ) : (
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" variant="outline" disabled={pending || body.trim() === ""}>
            {guideline ? "Save" : "Add"}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={guard.request}>
            {guideline ? "Discard" : "Cancel"}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error.message}
        </p>
      )}
    </form>
  );
}
