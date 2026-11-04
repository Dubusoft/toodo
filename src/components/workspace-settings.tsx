import { useState, useSyncExternalStore, type FormEvent } from "react";
import { FolderGit2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  compactSelectClass,
  inputClass,
  describeLocation,
  MoveWorkspaceForm,
  PathProblemNote,
  shortLocation,
} from "@/components/workspace-list";
import { PathLabel } from "@/components/path-label";
import { DiscardConfirm, useDiscardGuard } from "@/components/discard-guard";
import type { AgentMerge, Workspace } from "@/lib/bindings";
import {
  machineOf,
  useCreateBaseBranch,
  useMachineRuns,
  useMachineSettings,
  useSaveMachineSettings,
  useSetMachineRunLimit,
  useTasks,
  useUpdateWorkspace,
  useWorkspaceBranches,
} from "@/lib/queries";
import { cn } from "@/lib/utils";
import { workspaceCapabilities } from "@/lib/workspace-capabilities";
import { reachability, subscribeReachability } from "@/web/connection";


/**
 * Whether agents merge their own task pull request into the base branch once its checks
 * pass, which agents read through the MCP server; saved as soon as it changes.
 */
export function AgentMergeSetting({ workspace }: { workspace: Workspace }) {
  const updateWorkspace = useUpdateWorkspace();
  const value = updateWorkspace.isPending ? updateWorkspace.variables.agentMerge : workspace.agentMerge;
  // Saved on change, so it waits, like the buttons that change data, while the server is away.
  const reach = useSyncExternalStore(subscribeReachability, reachability);
  const serverDown = reach === "unreachable" || reach === "retrying";

  return (
    <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
      <label htmlFor="agent-merge" className="shrink-0">
        Agent merge
      </label>
      <select
        id="agent-merge"
        className={cn(compactSelectClass, "max-w-72")}
        value={value}
        disabled={updateWorkspace.isPending || serverDown}
        onChange={(e) => updateWorkspace.mutate({ ...workspace, agentMerge: e.target.value as AgentMerge })}
      >
        <option value="never">Never, stop at the pull request</option>
        <option value="afterChecks">Into {workspace.defaultBaseBranch} after checks pass</option>
      </select>
      {updateWorkspace.isError && (
        <span role="alert" className="truncate text-xs text-destructive">
          {updateWorkspace.error.message}
        </span>
      )}
    </div>
  );
}

/** Picker value of the "New branch..." option; `:` cannot appear in a branch name. */
const NEW_BRANCH = ":new";

/**
 * The location and default base branch of the workspace; the branch that new task branches
 * start from and pull requests target can be changed in place, either to a branch of the
 * repository or to a new branch created from one.
 */
export function BaseBranchForm({ workspace }: { workspace: Workspace }) {
  const updateWorkspace = useUpdateWorkspace();
  const createBaseBranch = useCreateBaseBranch();
  const tasks = useTasks();
  // A plain directory has no base branch to show or change.
  const { git } = workspaceCapabilities(workspace);
  // An open pull request targets the current branch, so it stays while a task awaits completion.
  const inReview = tasks.data?.filter((task) => task.workspaceId === workspace.id && task.status === "in_review");
  const locked = inReview === undefined || inReview.length > 0;
  const [draft, setDraft] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [newName, setNewName] = useState("");
  const [newFrom, setNewFrom] = useState(workspace.defaultBaseBranch);
  const branches = useWorkspaceBranches(workspace.id, draft !== null);
  const location = describeLocation(workspace.location);
  const current = workspace.defaultBaseBranch;
  const names = [...new Set([...(branches.data?.names ?? []), current])].sort();
  const name = newName.trim();
  const pending = updateWorkspace.isPending || createBaseBranch.isPending;
  const canSave =
    !pending && (draft === NEW_BRANCH ? name !== "" && !names.includes(name) && newFrom !== "" : draft !== current);
  const error = updateWorkspace.error ?? createBaseBranch.error;
  const guard = useDiscardGuard(draft === NEW_BRANCH && name !== "", () => setDraft(null), pending);

  function open() {
    updateWorkspace.reset();
    createBaseBranch.reset();
    setNewName("");
    setNewFrom(current);
    setDraft(current);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft === null || !canSave) return;
    const close = { onSuccess: () => setDraft(null) };
    if (draft === NEW_BRANCH) {
      createBaseBranch.mutate({ workspace: workspace.id, name, from: newFrom }, close);
    } else {
      updateWorkspace.mutate({ ...workspace, defaultBaseBranch: draft }, close);
    }
  }

  if (moving) {
    return <MoveWorkspaceForm workspace={workspace} onClose={() => setMoving(false)} />;
  }

  if (draft === null) {
    return (
      <p className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground max-md:flex-wrap">
        <PathLabel label="workspace path" full={location} short={shortLocation(workspace.location)} />
        <Button
          size="xs"
          variant="ghost"
          aria-label="Move workspace"
          title="Point the workspace at its repository on another machine or in another folder"
          onClick={() => setMoving(true)}
        >
          Move
        </Button>
        {git && (
          <>
            <span className="shrink-0">&middot; base</span>
            <code className="text-foreground">{workspace.defaultBaseBranch}</code>
          </>
        )}
        {workspace.pathProblem && <PathProblemNote problem={workspace.pathProblem} className="max-md:basis-full" />}
        {git && (
          <Button
            size="xs"
            variant="ghost"
            aria-label="Change base branch"
            disabled={locked}
            onClick={open}
          >
            Change
          </Button>
        )}
        {inReview && inReview.length > 0 && (
          <span className="text-xs max-md:basis-full md:truncate">
            Locked while {inReview.map((task) => `#${task.id}`).join(", ")} {inReview.length > 1 ? "are" : "is"}{" "}
            awaiting completion
          </span>
        )}
      </p>
    );
  }

  return (
    <form onSubmit={submit} aria-label="Base branch" className="flex flex-col gap-1.5" onKeyDown={guard.onKeyDown}>
      <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <span className="truncate">{location} &middot;</span>
        <label htmlFor="base-branch" className="shrink-0">
          Base branch
        </label>
        <select
          id="base-branch"
          className={cn(compactSelectClass, "max-w-56 font-mono")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
        >
          {names.map((branch) => (
            <option key={branch} value={branch}>
              {branch}
            </option>
          ))}
          <option value={NEW_BRANCH}>New branch...</option>
        </select>
        {branches.isFetching && <span role="status" className="text-xs">Loading branches...</span>}
      </div>
      {draft === NEW_BRANCH && (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <label htmlFor="new-base-branch" className="shrink-0">
            Name
          </label>
          <input
            id="new-base-branch"
            aria-label="New branch name"
            className={cn(inputClass, "max-w-56 font-mono")}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="release/2026"
            autoFocus
          />
          <label htmlFor="new-base-branch-from" className="shrink-0">
            from
          </label>
          <select
            id="new-base-branch-from"
            aria-label="Start new branch from"
            className={cn(compactSelectClass, "max-w-56 font-mono")}
            value={newFrom}
            onChange={(e) => setNewFrom(e.target.value)}
          >
            {names.map((branch) => (
              <option key={branch} value={branch}>
                {branch}
              </option>
            ))}
          </select>
          {names.includes(name) && <span className="text-xs">Branch {name} already exists; pick it above.</span>}
        </div>
      )}
      {guard.asking ? (
        <DiscardConfirm
          label="Discard new branch name"
          question="Discard the new branch name?"
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      ) : (
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" variant="outline" disabled={!canSave}>
            {draft === NEW_BRANCH ? "Create and save" : "Save"}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={guard.request}>
            Discard
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        New task branches start from this branch and pull requests target it.
        {draft === NEW_BRANCH && " The new branch is pushed to origin."}
      </p>
      {branches.error && (
        <p role="alert" className="text-xs text-destructive">
          Failed to load branches: {branches.error.message}
        </p>
      )}
      {branches.data?.fetchError && (
        <p className="text-xs text-muted-foreground" title={branches.data.fetchError}>
          Could not fetch origin; showing the branches known locally.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error.message}
        </p>
      )}
    </form>
  );
}

/**
 * How many runs the workspace's machine runs at once, with how many run and wait there now.
 * Runs started beyond the limit wait in the machine's queue and start as runs end; an empty
 * limit lets every run start at once.
 */
export function RunLimitForm({ workspace }: { workspace: Workspace }) {
  const machine = machineOf(workspace.location);
  const runs = useMachineRuns(machine);
  const setLimit = useSetMachineRunLimit();
  const [draft, setDraft] = useState<string | null>(null);
  const saved = runs.data?.maxConcurrentRuns?.toString() ?? "";
  const value = draft ?? saved;
  const parsed = value.trim() === "" ? null : Number(value);
  const valid = parsed === null || (Number.isInteger(parsed) && parsed >= 1);
  const machineName = machine.kind === "local" ? "the server" : machine.label;
  const error = runs.error ?? setLimit.error;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid) return;
    setLimit.mutate({ machine, limit: parsed }, { onSuccess: () => setDraft(null) });
  }

  return (
    <form
      onSubmit={submit}
      aria-label="Run limit"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
    >
      <label htmlFor="run-limit" className="shrink-0">
        Runs at once on {machineName}
      </label>
      <input
        id="run-limit"
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        className={cn(inputClass, "w-20 max-md:min-h-11")}
        placeholder="No limit"
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        disabled={!runs.isSuccess}
        aria-invalid={!valid}
      />
      <Button type="submit" size="xs" variant="outline" disabled={draft === null || !valid || setLimit.isPending}>
        Save
      </Button>
      {runs.data && (
        <span role="status" aria-label={`Runs on ${machineName}`}>
          {runs.data.activeRuns} running
          {runs.data.maxConcurrentRuns !== null && ` of ${runs.data.maxConcurrentRuns}`}, {runs.data.queuedRuns} queued
        </span>
      )}
      {!valid && (
        <p role="alert" className="basis-full text-destructive">
          Enter a whole number of at least 1, or leave it empty for no limit.
        </p>
      )}
      {error && (
        <p role="alert" className="basis-full text-destructive">
          {error.message}
        </p>
      )}
    </form>
  );
}

/**
 * Where worktrees of the workspace's machine are created. Shown as a one-line summary once
 * set, and as an open form while unset or being changed.
 */
export function WorktreeRootForm({ workspace }: { workspace: Workspace }) {
  const machine = machineOf(workspace.location);
  const settings = useMachineSettings(machine);
  const saveSettings = useSaveMachineSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const saved = settings.data?.worktreeRoot ?? "";
  const machineName = machine.kind === "local" ? "the server" : machine.label;
  const error = settings.error ?? saveSettings.error;
  const closeChange = () => {
    setDraft(null);
    setChanging(false);
  };
  const guard = useDiscardGuard(draft !== null && draft.trim() !== saved, closeChange, saveSettings.isPending);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    saveSettings.mutate(
      { machine, worktreeRoot: (draft ?? saved).trim() || null },
      {
        onSuccess: () => {
          setDraft(null);
          setChanging(false);
        },
      },
    );
  }

  if (settings.isSuccess && saved && !changing) {
    return (
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <FolderGit2 aria-hidden className="size-3.5 shrink-0" />
        <span className="shrink-0">Worktrees on {machineName} in</span>
        <code className="truncate text-foreground" title={saved}>
          {saved}
        </code>
        <Button size="xs" variant="ghost" aria-label="Change worktree root" onClick={() => setChanging(true)}>
          Change
        </Button>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      aria-label="Worktree root"
      onKeyDown={changing ? guard.onKeyDown : undefined}
      className={cn(
        "flex flex-col gap-1.5 rounded-xl border p-3",
        settings.isSuccess && !saved && "border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30",
      )}
    >
      <div className="flex items-center gap-2 max-md:flex-wrap">
        <label htmlFor="worktree-root" className="shrink-0 text-xs text-muted-foreground max-md:basis-full">
          Worktree root on {machineName}
        </label>
        <input
          id="worktree-root"
          className={cn(inputClass, "font-mono max-md:min-w-0 max-md:flex-1")}
          placeholder={/^([a-zA-Z]:|\\\\)/.test(workspace.location.path) ? "D:\\worktrees" : "/srv/worktrees"}
          value={draft ?? saved}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!settings.isSuccess}
        />
        <Button type="submit" size="sm" variant="outline" disabled={draft === null || saveSettings.isPending}>
          Save
        </Button>
        {changing && !guard.asking && (
          <Button type="button" size="sm" variant="ghost" onClick={guard.request}>
            Discard
          </Button>
        )}
      </div>
      {guard.asking && (
        <DiscardConfirm
          label="Discard worktree root change"
          question="Discard the new worktree root?"
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      )}
      {settings.isSuccess && !saved && (
        <p className="text-xs text-muted-foreground">Set a worktree root to start tasks on this machine.</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error.message}
        </p>
      )}
    </form>
  );
}
