import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/workspace-list";
import type { PullRequestOptions, Workspace } from "@/lib/bindings";
import { useSetWorkspacePullRequestOptions, useWorkspacePullRequestOptions } from "@/lib/queries";
import { cn } from "@/lib/utils";

function splitList(text: string): string[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function pullRequestOptionsSummary(options: PullRequestOptions): string {
  return [
    options.draft ? "Draft" : "Ready for review",
    options.reviewers.length > 0 ? `reviewers ${options.reviewers.join(", ")}` : "no reviewers",
    options.labels.length > 0 ? `labels ${options.labels.join(", ")}` : "no labels",
  ].join("; ");
}

function PullRequestOptionsForm({
  workspace,
  saved,
  onClose,
}: {
  workspace: Workspace;
  saved: PullRequestOptions;
  onClose: () => void;
}) {
  const save = useSetWorkspacePullRequestOptions();
  const [draft, setDraft] = useState(saved.draft);
  const [reviewers, setReviewers] = useState(saved.reviewers.join(", "));
  const [labels, setLabels] = useState(saved.labels.join(", "));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate(
      { workspace: workspace.id, options: { draft, reviewers: splitList(reviewers), labels: splitList(labels) } },
      { onSuccess: onClose },
    );
  }

  return (
    <form
      aria-label={`Pull request options of ${workspace.name}`}
      onSubmit={submit}
      className="flex flex-col gap-2 rounded-lg border p-2 text-sm"
    >
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <label className="flex items-center gap-2 self-center">
          <input type="checkbox" checked={draft} onChange={(event) => setDraft(event.target.checked)} />
          <span>Open as draft</span>
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Reviewers (comma-separated logins or org/team)</span>
          <input
            className={cn(inputClass, "w-64 max-w-full")}
            value={reviewers}
            placeholder="octocat, acme/core"
            onChange={(event) => setReviewers(event.target.value)}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Labels (comma-separated)</span>
          <input
            className={cn(inputClass, "w-64 max-w-full")}
            value={labels}
            placeholder="needs review"
            onChange={(event) => setLabels(event.target.value)}
          />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" size="xs" disabled={save.isPending}>
          {save.isPending ? "Saving..." : "Save"}
        </Button>
        <Button type="button" size="xs" variant="ghost" disabled={save.isPending} onClick={onClose}>
          Cancel
        </Button>
        {save.error && (
          <span role="alert" className="min-w-0 break-words text-xs text-destructive">
            {save.error.message}
          </span>
        )}
      </div>
    </form>
  );
}

export function WorkspacePullRequestOptions({ workspace }: { workspace: Workspace }) {
  const options = useWorkspacePullRequestOptions(workspace.id);
  const [editing, setEditing] = useState(false);

  if (editing && options.data) {
    return <PullRequestOptionsForm workspace={workspace} saved={options.data} onClose={() => setEditing(false)} />;
  }
  return (
    <p className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
      <span className="shrink-0">Pull requests</span>
      <span aria-label="Pull request options" className="min-w-0 truncate text-foreground">
        {options.data
          ? pullRequestOptionsSummary(options.data)
          : options.isError
            ? options.error.message
            : "Loading..."}
      </span>
      <Button
        size="xs"
        variant="ghost"
        aria-label="Change pull request options"
        title="Whether pull requests of this workspace's tasks open as drafts, and the reviewers and labels they get"
        disabled={!options.data}
        onClick={() => setEditing(true)}
      >
        Change
      </Button>
    </p>
  );
}
