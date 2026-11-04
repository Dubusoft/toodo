import { Suspense } from "react";
import { CircleCheck, CircleX, GitCommitHorizontal, GitMerge, GitPullRequest, type LucideIcon } from "lucide-react";
import type { ActivityKind, AgentStatus, AgentStatusTransition, NoteKind, Task } from "@/lib/bindings";
import { useAgentStatusTransitions, useTaskActivity } from "@/lib/queries";
import { pullRequestNumber } from "@/lib/review";
import { isPaused } from "@/lib/task-graph";
import { formatFull } from "@/lib/timeline";
import { When } from "@/components/when";
import { markdownPreview } from "@/lib/markdown";
import { toneChip, toneText, type Tone } from "@/lib/status-styles";
import { cn } from "@/lib/utils";
import { type WorkspaceCapabilities } from "@/lib/workspace-capabilities";
import { openUrl } from "@/web/opener";
import { DetailField, Markdown } from "@/components/task-common";


/** How each kind of git activity is named and marked, in the tones of the status glossary. */
const activityKinds: Record<ActivityKind, { label: string; icon: LucideIcon; tone: Tone }> = {
  commit: { label: "Commit", icon: GitCommitHorizontal, tone: "neutral" },
  pr_opened: { label: "Pull request opened", icon: GitPullRequest, tone: "review" },
  checks_passed: { label: "CI passed", icon: CircleCheck, tone: "success" },
  checks_failed: { label: "CI failed", icon: CircleX, tone: "danger" },
  pr_merged: { label: "Merged", icon: GitMerge, tone: "success" },
};

/** A pull request of the git activity as a short link, e.g. `#12`. */
function PullRequestRef({ url }: { url: string }) {
  const number = pullRequestNumber(url);
  const open = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    openUrl(url).catch((error: unknown) => console.error(`Failed to open ${url}`, error));
  };
  return (
    <a
      href={url}
      title={url}
      aria-label={number ? `Pull request #${number}` : "Pull request"}
      onClick={open}
      onAuxClick={open}
      className="shrink-0 text-primary underline underline-offset-2 hover:no-underline"
    >
      {number ? `#${number}` : "PR"}
    </a>
  );
}

/**
 * The git activity of a task in the details sheet, oldest first: its commits, pull request,
 * CI results, and merge, as the background checks saw them. Only workspaces with a git
 * repository whose merges complete tasks track it, so the others show nothing.
 */
export function TaskActivity({ task, capabilities }: { task: Task; capabilities: WorkspaceCapabilities }) {
  const tracked = capabilities.git && capabilities.merge;
  const activity = useTaskActivity(task.id, tracked && (task.status !== "planned" || isPaused(task)));

  if (!tracked) {
    return null;
  }
  if (activity.isError) {
    return (
      <p role="alert" className="text-xs text-destructive">
        Failed to load git activity: {activity.error.message}
      </p>
    );
  }
  if (!activity.data || activity.data.length === 0) {
    return null;
  }
  return (
    <DetailField label="Git activity">
      <ol
        aria-label={`Git activity of #${task.id}`}
        className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 max-md:gap-y-1.5"
      >
        {activity.data.map(({ kind, externalRef, title, author, occurredAt }) => {
          const { label, icon: Icon, tone } = activityKinds[kind];
          return (
            <li
              key={`${kind}:${externalRef}`}
              className="col-span-full grid grid-cols-subgrid items-baseline"
              title={author ?? undefined}
            >
              <When className="text-muted-foreground" at={occurredAt} />
              <span className="flex min-w-0 items-baseline gap-2 max-md:flex-wrap max-md:gap-y-0">
                <span className={cn("inline-flex shrink-0 items-baseline gap-1", toneText[tone])}>
                  <Icon aria-hidden className="size-3 self-center" />
                  {label}
                </span>
                {kind === "pr_opened" || kind === "pr_merged" ? (
                  <PullRequestRef url={externalRef} />
                ) : (
                  <code className="shrink-0 text-muted-foreground">{externalRef.slice(0, 7)}</code>
                )}
                <span className="min-w-0 break-words-keep max-md:basis-full">{title}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </DetailField>
  );
}

/** How each agent status is named in the agent's history, in the tones of the status glossary. */
const agentStates: Record<AgentStatus, { label: string; tone: Tone }> = {
  idle: { label: "Idle", tone: "neutral" },
  working: { label: "Working", tone: "info" },
  blocked: { label: "Needs input", tone: "attention" },
  done: { label: "Done", tone: "success" },
};

/** The most recent changes the agent history lists; the time worked counts all of them. */
const shownTransitions = 20;

/**
 * How long the agent was working, in seconds: each working status lasts until the next change,
 * the current one until `now`.
 */
export function workingSeconds(transitions: readonly AgentStatusTransition[], now: number): number {
  return transitions.reduce((total, { status, at }, index) => {
    if (status !== "working") return total;
    const end = transitions[index + 1]?.at ?? now;
    return total + Math.max(0, end - at);
  }, 0);
}

/** A time an agent worked, e.g. `<1m`, `25m`, or `3h 5m`. */
export function formatWorked(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * When the agent in the task's herdr workspace changed what it was doing, as herdr reported it,
 * with the time it worked in all: when it stalled waiting for input, went idle, or was gone
 * because its pane closed or herdr stopped. Only herdr workspaces report it.
 */
export function AgentActivity({ task, capabilities }: { task: Task; capabilities: WorkspaceCapabilities }) {
  const tracked = capabilities.herdr;
  const transitions = useAgentStatusTransitions(task.id, tracked && (task.status !== "planned" || isPaused(task)));

  if (!tracked) {
    return null;
  }
  if (transitions.isError) {
    return (
      <p role="alert" className="text-xs text-destructive">
        Failed to load the agent's history: {transitions.error.message}
      </p>
    );
  }
  const all = transitions.data ?? [];
  if (all.length === 0) {
    return null;
  }
  const shown = all.slice(-shownTransitions);
  const worked = formatWorked(workingSeconds(all, Date.now() / 1000));
  return (
    <DetailField label="Agent activity">
      <p aria-label={`Time the agent of #${task.id} worked`} className="text-muted-foreground">
        Worked {worked}
        {all.length > shown.length && `; the last ${shown.length} of ${all.length} changes:`}
      </p>
      <ol
        aria-label={`Agent activity of #${task.id}`}
        className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 max-md:gap-y-1.5"
      >
        {shown.map(({ status, at }, index) => (
          <li key={index} className="col-span-full grid grid-cols-subgrid items-baseline">
            <When className="text-muted-foreground" at={at} />
            {status === null ? (
              <span className="text-muted-foreground">No agent</span>
            ) : (
              <span className={toneText[agentStates[status].tone]}>{agentStates[status].label}</span>
            )}
          </li>
        ))}
      </ol>
    </DetailField>
  );
}

const noteKindLabels: Record<NoteKind, string> = { progress: "Progress", blocker: "Blocker" };

function NoteKindBadge({ kind }: { kind: NoteKind }) {
  return (
    <span
      data-note-kind={kind}
      className={cn(
        "shrink-0 rounded-md px-1.5 font-medium",
        kind === "blocker" ? toneChip.attention : toneChip.neutral,
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
