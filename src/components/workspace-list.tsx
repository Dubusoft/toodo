import { useId, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Ban, ChevronLeft, ChevronRight, Laptop, Plus, Server, TriangleAlert, X } from "lucide-react";
import { FolderInput, joinPath, withoutTrailingSeparator } from "@/components/folder-input";
import { Button } from "@/components/ui/button";
import type {
  CompletionMode,
  HerdrMachine,
  Machine,
  NewWorkspace,
  PathProblem,
  Runner,
  Source,
  Workspace,
  WorkspaceId,
  WorkspaceLocation,
} from "@/lib/bindings";
import { keepFocusIn } from "@/lib/focus-trap";
import { normalizePath, shortPath } from "@/lib/paths";
import {
  useCreateWorkspace,
  useDeleteWorkspace,
  useHerdrMachines,
  useHomeDirectory,
  useMoveWorkspace,
  useRunnerHealth,
  useTestSshMachine,
  useWorkspaces,
} from "@/lib/queries";
import { toneText } from "@/lib/status-styles";
import { cn } from "@/lib/utils";
import {
  choiceOf,
  completionLabels,
  completionProblem,
  completions,
  repositoryKinds,
  repositoryLabels,
  repositoryProblem,
  runnerLabels,
  runnerLocationProblem,
  runnerProblem,
  runners,
  sourceLabels,
  sources,
  withPick,
  type Picks,
  type RepositoryKind,
} from "@/lib/workspace-axes";
import { reachability, subscribeReachability, unreachableCause } from "@/web/connection";

export const inputClass =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm outline-none max-md:h-11 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** A small select for toolbars and inline pickers. */
export const compactSelectClass =
  "h-6 rounded-md border border-input bg-background px-1.5 text-xs outline-none max-md:h-11 max-md:px-2.5 max-md:text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

export function describeLocation(location: WorkspaceLocation): string {
  const path = normalizePath(location.path);
  return location.kind === "local" ? path : `${location.machine}:${path}`;
}

/** The location with only the last folders of its path. */
export function shortLocation(location: WorkspaceLocation): string {
  const path = shortPath(location.path);
  return location.kind === "local" ? path : `${location.machine}:${path}`;
}

const pathProblems: Record<PathProblem, string> = {
  foreign: "Windows path, not on this server",
  missing: "Folder not found on the server",
};

/**
 * Why the server cannot use the repository path of the workspace, e.g. a Windows path kept
 * from the desktop app; git features of the workspace fail until the path is corrected.
 */
export function PathProblemNote({ problem, className }: { problem: PathProblem; className?: string }) {
  return (
    <span
      className={cn("flex min-w-0 items-start gap-1 text-xs text-destructive", className)}
      title="Toodo cannot run git in this repository until its path is corrected"
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
      <span>{pathProblems[problem]}</span>
    </span>
  );
}

/** The source, completion, and runner of a workspace, read-only: they are set when it is added. */
export function WorkspaceAxes({ workspace }: { workspace: Workspace }) {
  const source = sourceLabels[workspace.source];
  const completion = completionLabels[workspace.completion];
  const runner = runnerLabels[workspace.runner];
  return (
    <span
      className="text-xs text-muted-foreground"
      title={`Source ${source}, completion ${completion}, runner ${runner}; set when the workspace was added`}
    >
      {/* A narrow sidebar wraps the line between the axes, not inside one. */}
      <span className="whitespace-nowrap">{source}</span> &middot; <span className="whitespace-nowrap">{completion}</span>{" "}
      &middot; <span className="whitespace-nowrap">{runner}</span>
    </span>
  );
}

/** SSH host of a herdr machine, or `null` for this computer. */
type MachineKey = string | null;

function machineKeyOf(location: WorkspaceLocation): MachineKey {
  return location.kind === "local" ? null : location.machine;
}

/** Why herdr cannot run commands on `host`, or `null` when it can. */
function herdrProblem(host: string, machines: HerdrMachine[]): string | null {
  const saved = machines.filter((machine) => machine.target === host);
  if (saved.length === 0) return "Not saved in herdr";
  return saved.some((machine) => machine.enabled) ? null : "Disabled in herdr";
}

/** `path` ending in a separator, ready for a folder name to be typed after it. */
function withSeparator(path: string): string {
  return /[\\/]$/.test(path) ? path : joinPath(path, "");
}

/** A field with a visible label above it and optional help text below. */
function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: (ids: { id: string; describedBy: string | undefined }) => ReactNode;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      {children({ id, describedBy: help ? helpId : undefined })}
      {help && (
        <p id={helpId} className="text-xs text-muted-foreground">
          {help}
        </p>
      )}
    </div>
  );
}

function baseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

function repositoryName(url: string): string {
  return baseName(url.trim().replace(/\.git$/, "")).split(":").pop() ?? "";
}

type WorkspaceListProps = {
  selectedId: WorkspaceId | null;
  onSelect: (id: WorkspaceId) => void;
};

export function WorkspaceList({ selectedId, onSelect }: WorkspaceListProps) {
  const workspaces = useWorkspaces();
  const reach = useSyncExternalStore(subscribeReachability, reachability);
  const serverDown = reach === "unreachable" || reach === "retrying";
  const herdrMachines = useHerdrMachines();
  // Without herdr on the server there are no SSH machines, so failing to list them is no error.
  const herdrMissing = useRunnerHealth().data?.herdr.installed === false;
  const [adding, setAdding] = useState<{ machine: MachineKey } | null>(null);
  // The new workspace dialog gives the focus back to the button that opened it.
  const opener = useRef<HTMLElement | null>(null);
  const stopAdding = () => {
    setAdding(null);
    opener.current?.focus();
  };
  const [addingMachine, setAddingMachine] = useState(false);

  const saved = herdrMachines.data ?? [];
  const remotes = [
    ...new Set([
      ...saved.map((machine) => machine.target),
      ...(workspaces.data ?? []).flatMap((w) => (w.location.kind === "ssh" ? [w.location.machine] : [])),
    ]),
  ];
  const machines: MachineKey[] = [null, ...remotes];

  return (
    <section aria-labelledby="workspaces-heading" className="flex shrink-0 flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 id="workspaces-heading" className="text-xs font-medium uppercase text-muted-foreground">
          Workspaces
        </h2>
        <Button variant="ghost" size="xs" onClick={() => setAddingMachine((open) => !open)}>
          {!addingMachine && <Plus />}
          {addingMachine ? "Cancel" : "Add machine"}
        </Button>
      </div>

      {addingMachine && <AddMachineHelp herdrMissing={herdrMissing} onClose={() => setAddingMachine(false)} />}
      {herdrMachines.isError &&
        (herdrMissing ? (
          <p className="text-xs text-muted-foreground">
            herdr is not installed on this server, so there are no SSH machines; workspaces on Local can use runner{" "}
            {runnerLabels.plain}.
          </p>
        ) : (
          <p role="alert" className="text-xs text-destructive">
            Failed to list herdr machines: {herdrMachines.error.message}
          </p>
        ))}
      {workspaces.isPending && !serverDown && (
        <p className="text-sm text-muted-foreground">Loading workspaces...</p>
      )}
      {(workspaces.isError || (workspaces.isPending && serverDown)) && (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm text-destructive">
          <p>
            Failed to load workspaces:{" "}
            {workspaces.error?.message ?? (unreachableCause() || "The Toodo server does not answer.")}
          </p>
          <Button size="xs" variant="outline" onClick={() => void workspaces.refetch()}>
            Retry now
          </Button>
        </div>
      )}
      {workspaces.data?.length === 0 && adding === null && (
        <p className="text-sm text-muted-foreground">No workspaces yet.</p>
      )}

      <div className="flex flex-col gap-3">
        {workspaces.data &&
          machines.map((machine) => {
            const label = machine ?? "Local";
            const items = workspaces.data.filter((w) => machineKeyOf(w.location) === machine);
            const problem = machine !== null && herdrMachines.isSuccess ? herdrProblem(machine, saved) : null;
            return (
              <section key={label} aria-label={`Machine ${label}`} className="flex flex-col gap-1">
                <div className="flex items-center gap-1">
                  <h3 className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-xs font-semibold">
                    {machine === null ? (
                      <Laptop aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <Server aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{label}</span>
                    {problem && <span className="ml-1.5 font-normal text-destructive">{problem}</span>}
                  </h3>
                  <Button
                    size="xs"
                    variant="outline"
                    aria-label={`Add workspace on ${label}`}
                    title="Add a workspace on this machine"
                    aria-haspopup="dialog"
                    aria-expanded={adding !== null && adding.machine === machine}
                    onClick={(event) => {
                      opener.current = event.currentTarget;
                      setAdding({ machine });
                    }}
                  >
                    <Plus />
                    Add
                  </Button>
                </div>
                {items.length > 0 && (
                  <ul className="flex flex-col gap-1">
                    {items.map((workspace) => (
                      <WorkspaceItem
                        key={workspace.id}
                        workspace={workspace}
                        selected={workspace.id === selectedId}
                        onSelect={onSelect}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
      </div>
      {adding && (
        <NewWorkspaceDialog
          machine={adding.machine}
          onCreated={(workspace) => {
            stopAdding();
            onSelect(workspace.id);
          }}
          onClose={stopAdding}
        />
      )}
    </section>
  );
}

type WorkspaceItemProps = {
  workspace: Workspace;
  selected: boolean;
  onSelect: (id: WorkspaceId) => void;
};

/** A workspace in the list; removing it asks for confirmation first. */
function WorkspaceItem({ workspace, selected, onSelect }: WorkspaceItemProps) {
  const deleteWorkspace = useDeleteWorkspace();
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="flex flex-col gap-1">
      <div
        className={cn(
          "group flex items-center rounded-lg hover:bg-sidebar-accent",
          selected && "bg-sidebar-accent",
        )}
      >
        <button
          type="button"
          aria-current={selected ? "true" : undefined}
          onClick={() => onSelect(workspace.id)}
          className="flex min-w-0 flex-1 flex-col px-2.5 py-1.5 text-left"
        >
          <span className="truncate text-sm font-medium">{workspace.name}</span>
          <span className="truncate text-xs text-muted-foreground" title={describeLocation(workspace.location)}>
            {shortPath(workspace.location.path)}
          </span>
          <WorkspaceAxes workspace={workspace} />
          {workspace.pathProblem && <PathProblemNote problem={workspace.pathProblem} />}
        </button>
        {!confirming && (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Remove ${workspace.name}`}
            title="Remove the workspace and its tasks from Toodo"
            className="mr-1 shrink-0 opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
            onClick={() => {
              deleteWorkspace.reset();
              setConfirming(true);
            }}
          >
            <X />
          </Button>
        )}
      </div>
      {confirming && (
        <div
          role="group"
          aria-label={`Remove ${workspace.name}`}
          className="flex flex-col gap-1.5 rounded-lg border p-2"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !deleteWorkspace.isPending) {
              event.preventDefault();
              setConfirming(false);
            }
          }}
        >
          <p className="text-xs text-muted-foreground">
            Remove {workspace.name} and its tasks from Toodo? The repository, worktrees, and herdr workspaces are
            kept.
          </p>
          {deleteWorkspace.isError && (
            <p role="alert" className="text-xs text-destructive">
              {deleteWorkspace.error.message}
            </p>
          )}
          <div className="flex gap-1">
            <Button
              changesData
              size="xs"
              variant="destructive"
              aria-label={`Confirm remove ${workspace.name}`}
              disabled={deleteWorkspace.isPending}
              onClick={() => deleteWorkspace.mutate(workspace.id)}
            >
              {deleteWorkspace.isPending ? "Removing..." : "Remove"}
            </Button>
            <Button size="xs" variant="ghost" autoFocus onClick={() => setConfirming(false)}>
              Back
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/** Calls `close` when Escape is pressed inside an inline form, unless it is busy. */
export function escapeCloses(close: () => void, busy = false) {
  return (event: KeyboardEvent) => {
    if (event.key === "Escape" && !busy && !event.defaultPrevented) {
      event.preventDefault();
      close();
    }
  };
}

/**
 * Moves a workspace to the same repository at another location, such as the Windows host a
 * repository kept from the desktop app lives on. The tasks stay with the workspace.
 */
export function MoveWorkspaceForm({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  const moveWorkspace = useMoveWorkspace();
  const herdrMachines = useHerdrMachines();
  const workspaces = useWorkspaces();
  const [machine, setMachine] = useState<MachineKey>(machineKeyOf(workspace.location));
  const [folder, setFolder] = useState(workspace.location.path);
  const remotes = [
    ...new Set([
      ...(herdrMachines.data ?? []).map((saved) => saved.target),
      ...(workspaces.data ?? []).flatMap((w) => (w.location.kind === "ssh" ? [w.location.machine] : [])),
    ]),
  ];
  const path = withoutTrailingSeparator(folder.trim());

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const location: WorkspaceLocation = machine === null ? { kind: "local", path } : { kind: "ssh", machine, path };
    moveWorkspace.mutate({ id: workspace.id, location }, { onSuccess: onClose });
  }

  return (
    <form
      onSubmit={submit}
      aria-label={`Move ${workspace.name}`}
      className="flex flex-col gap-2 rounded-lg border p-2"
      onKeyDown={escapeCloses(onClose, moveWorkspace.isPending)}
    >
      <p className="text-xs text-muted-foreground">
        Point the workspace at the same repository on another machine or in another folder. Its tasks stay. A
        repository on a Windows host takes a Windows path such as D:\dev\repo.
      </p>
      <Field label="Machine">
        {({ id }) => (
          <select
            id={id}
            className={inputClass}
            value={machine ?? ""}
            onChange={(e) => setMachine(e.target.value === "" ? null : e.target.value)}
            autoFocus
          >
            <option value="">Local (this server)</option>
            {remotes.map((remote) => (
              <option key={remote} value={remote}>
                {remote}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Folder" help="The repository's own folder on that machine.">
        {({ id, describedBy }) => (
          <FolderInput
            id={id}
            machine={machine === null ? { kind: "local" } : { kind: "ssh", label: machine }}
            className={inputClass}
            describedBy={describedBy}
            value={folder}
            onChange={setFolder}
            required
          />
        )}
      </Field>
      {moveWorkspace.isError && (
        <p role="alert" className="text-xs break-words text-destructive">
          {moveWorkspace.error.message}
        </p>
      )}
      <div className="flex gap-1">
        <Button type="submit" size="sm" disabled={moveWorkspace.isPending || path === ""}>
          {moveWorkspace.isPending ? "Moving..." : "Move workspace"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={moveWorkspace.isPending} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * The server cannot open a terminal for `herdr machine add`, so the user runs it on the server,
 * after testing here that the server reaches the host over SSH and finds git there.
 */
function AddMachineHelp({ herdrMissing, onClose }: { herdrMissing: boolean; onClose: () => void }) {
  const [notice, setNotice] = useState<string | null>(null);
  const [host, setHost] = useState("");
  const test = useTestSshMachine();
  const hostId = useId();
  const command = `herdr machine add ${host.trim() || "<host>"}`;

  function runTest(event: FormEvent) {
    event.preventDefault();
    if (host.trim() !== "") test.mutate(host.trim());
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setNotice("Copied the command.");
    } catch (error) {
      setNotice(`Could not copy: ${String(error)}`);
    }
  }

  return (
    <section
      aria-label="Add machine"
      className="flex flex-col gap-2 rounded-lg border p-2"
      onKeyDown={escapeCloses(onClose)}
    >
      <p className="text-xs text-muted-foreground">
        {herdrMissing && "Install herdr on the server first; SSH machines need it. "}
        Enter an SSH host from the server's ~/.ssh/config and test the connection. herdr asks questions in a terminal,
        which the Toodo server cannot open, so then run the command below in a terminal on the server and reload the
        machine list here.
      </p>
      <form aria-label="Test SSH connection" className="flex flex-col gap-1" onSubmit={runTest}>
        <label htmlFor={hostId} className="text-xs font-medium">
          SSH host
        </label>
        <div className="flex items-center gap-1">
          <input
            id={hostId}
            className={inputClass}
            value={host}
            placeholder="devbox"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setHost(event.target.value);
              test.reset();
            }}
          />
          <Button type="submit" size="sm" variant="outline" disabled={host.trim() === "" || test.isPending}>
            {test.isPending ? "Testing..." : "Test connection"}
          </Button>
        </div>
      </form>
      {test.isError && (
        <p role="alert" className="text-xs text-destructive">
          Could not test the connection: {test.error.message}
        </p>
      )}
      {test.data?.problem && (
        <p role="alert" className="text-xs text-destructive">
          {test.data.problem}
        </p>
      )}
      {test.data?.gitVersion && (
        <p role="status" className="text-xs text-muted-foreground">
          Connected to {test.variables} without a prompt and found {test.data.gitVersion}. Run the command below to
          save it in herdr.
        </p>
      )}
      <div className="flex flex-col items-start gap-1">
        <code className="max-w-full rounded bg-muted px-1.5 py-1 text-xs" aria-label="Add machine command">
          {command}
        </code>
        <Button type="button" size="sm" variant="outline" onClick={() => void copy()}>
          Copy command
        </Button>
      </div>
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </section>
  );
}

/** The steps of a new workspace, in order; the options of a step depend on the steps before it. */
const steps = ["Source", "Completion", "Runner", "Details"] as const;

const sourceDescriptions: Record<Source, string> = {
  none: "A folder without git. Tasks get no branch, worktree, or pull request.",
  local_git: "A git repository without GitHub. Task branches merge locally.",
  github: "A git repository with a GitHub origin. Tasks ship as pull requests.",
};

const repositoryDescriptions: Record<RepositoryKind, string> = {
  open: "The folder already holds the repository.",
  init: "Make a folder a new git repository without a remote.",
  clone: "Clone a repository URL into a new folder.",
};

const completionDescriptions: Record<CompletionMode, string> = {
  manual: "When its criteria are met; nothing is merged.",
  local_merge: "Once its branch is merged into the base branch locally.",
  pr_merge: "Once its pull request is merged into the base branch.",
};

/** The guide that compares the runners, for the runner step of a new workspace. */
const runnerGuideUrl = "https://github.com/dev-bokdong/toodo/blob/main/docs/runners.md";

const runnerDescriptions: Record<Runner, string> = {
  herdr: "Opens agents in herdr on a worktree and branch of the task.",
  plain: "Runs Claude or Codex in the background in a worktree and branch of the task, without herdr.",
  tmux: "Runs Claude or Codex in a tmux session in a worktree and branch of the task, without herdr.",
  none: "Only marks the task in progress.",
};

/** What the herdr choice of a workspace on this server notes while herdr does not run there. */
function herdrDownNote(installed: boolean): string {
  return installed
    ? `herdr is not running on this server; start it there before starting tasks, or choose ${runnerLabels.plain}.`
    : `herdr is not running on this server since it is not installed there; install and start herdr before starting tasks, or choose ${runnerLabels.plain}.`;
}

/** The submit button of the last step, by how the folder becomes a workspace. */
const submitLabels: Record<RepositoryKind | "none", { submit: string; pending: string }> = {
  clone: { submit: "Clone workspace", pending: "Cloning..." },
  open: { submit: "Open workspace", pending: "Opening..." },
  init: { submit: "Init workspace", pending: "Initializing..." },
  none: { submit: "Add workspace", pending: "Adding..." },
};

type Choice<T extends string> = {
  value: T;
  label: string;
  description: string;
  /** A warning under the description that leaves the option open, such as herdr not running. */
  note?: string | null;
  /** Why an earlier step rules the option out; the option is disabled and shows this instead of its description. */
  problem: string | null;
};

/** One choice of a step, as a group of radio cards. */
function ChoiceGroup<T extends string>({
  legend,
  value,
  choices,
  onChange,
  autoFocus = false,
}: {
  legend: string;
  value: T | null;
  choices: Choice<T>[];
  onChange: (value: T) => void;
  /** Focuses the picked option when the group appears, as the first choice of its step. */
  autoFocus?: boolean;
}) {
  const id = useId();
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      {choices.map((choice) => {
        const checked = choice.value === value;
        const disabled = choice.problem !== null;
        const note = disabled ? null : (choice.note ?? null);
        const labelId = `${id}-${choice.value}`;
        return (
          <label
            key={choice.value}
            className={cn(
              "flex items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors has-focus-visible:border-ring has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
              disabled ? "cursor-not-allowed border-dashed" : "cursor-pointer hover:bg-muted",
              checked && "border-ring bg-secondary hover:bg-secondary",
            )}
          >
            <input
              type="radio"
              name={id}
              value={choice.value}
              checked={checked}
              disabled={disabled}
              autoFocus={autoFocus && checked}
              aria-labelledby={labelId}
              aria-describedby={note === null ? `${labelId}-about` : `${labelId}-about ${labelId}-note`}
              // A click event that still reaches a disabled option, e.g. a synthetic one, picks nothing.
              onChange={() => !disabled && onChange(choice.value)}
              className="mt-0.5 size-4 shrink-0 accent-primary"
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span id={labelId} className={cn("text-sm font-medium", disabled && "text-muted-foreground")}>
                {choice.label}
              </span>
              <span id={`${labelId}-about`} className="flex items-start gap-1 text-xs text-muted-foreground">
                {disabled && <Ban aria-hidden className="mt-0.5 size-3 shrink-0" />}
                {choice.problem ?? choice.description}
              </span>
              {note !== null && (
                <span id={`${labelId}-note`} className={cn("flex items-start gap-1 text-xs", toneText.attention)}>
                  <TriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0" />
                  {note}
                </span>
              )}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

type NewWorkspaceDialogProps = {
  machine: MachineKey;
  onCreated: (workspace: Workspace) => void;
  onClose: () => void;
};

/**
 * Adds a workspace on `machine` step by step: what its folder holds and how a repository gets
 * there, when its tasks are done, and what starting one does; then where it lives. An option
 * that an earlier step rules out is disabled with the reason, and changing an earlier step
 * resets a later pick that it rules out to the default.
 */
export function NewWorkspaceDialog({ machine, onCreated, onClose }: NewWorkspaceDialogProps) {
  const createWorkspace = useCreateWorkspace();
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [step, setStep] = useState(0);
  const [picks, setPicks] = useState<Picks>({ source: "github", repository: null, completion: null, runner: null });
  const [url, setUrl] = useState("");
  const [folderDraft, setFolder] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [baseBranch, setBaseBranch] = useState("");

  const label = machine ?? "Local";
  const target: Machine = machine === null ? { kind: "local" } : { kind: "ssh", label: machine };
  const herdr = useRunnerHealth().data?.herdr;
  // While herdr does not run on this server, a workspace here runs its agents with plain by
  // default and the herdr choice says why; until the server has said, herdr stays the default.
  const herdrNote = machine === null && herdr !== undefined && !herdr.running ? herdrDownNote(herdr.installed) : null;
  const withoutHerdr = herdrNote !== null;
  const choice = choiceOf(picks, withoutHerdr);
  const cloning = choice.repository === "clone";
  const home = useHomeDirectory(target).data;
  // A clone makes a new folder under home. The others name the workspace's own folder, so
  // they start inside home, and the folder has to be finished before submitting.
  const startFolder = home === undefined ? "" : cloning ? home : withSeparator(home);
  const folder = folderDraft ?? startFolder;
  const folderUntouched = !cloning && folderDraft === null;
  const effectiveName = name ?? (cloning ? repositoryName(url) : folderUntouched ? "" : baseName(folder));
  const path =
    cloning && folder.trim() && effectiveName.trim()
      ? joinPath(folder.trim(), effectiveName.trim())
      : withoutTrailingSeparator(folder.trim());
  const last = step === steps.length - 1;
  const busy = createWorkspace.isPending;
  const labels = submitLabels[choice.repository ?? "none"];
  const summaries = [sourceLabels[choice.source], completionLabels[choice.completion], runnerLabels[choice.runner], label];
  const folderHelp = cloning
    ? undefined
    : choice.source === "none"
      ? "The folder the tasks are about. Toodo runs no git or herdr there."
      : "The repository's own folder.";

  function choose(change: Partial<Picks>) {
    const next = withPick(picks, change, withoutHerdr);
    // A clone names the folder to clone into, the others the workspace's own folder.
    if ((choiceOf(next, withoutHerdr).repository === "clone") !== cloning) setFolder(null);
    setPicks(next);
  }

  function goTo(index: number) {
    setStep(index);
  }

  function close() {
    if (!busy) onClose();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!last) {
      goTo(step + 1);
      return;
    }
    const location: WorkspaceLocation = machine === null ? { kind: "local", path } : { kind: "ssh", machine, path };
    const workspace: NewWorkspace = {
      name: effectiveName,
      location,
      repository:
        choice.repository === null
          ? null
          : choice.repository === "clone"
            ? { kind: "clone", url }
            : { kind: choice.repository },
      source: choice.source,
      completion: choice.completion,
      runner: choice.runner,
      defaultBaseBranch: choice.source === "none" ? null : baseBranch.trim() || null,
    };
    createWorkspace.mutate(workspace, { onSuccess: onCreated });
  }

  return (
    <div className="fixed inset-0 z-50">
      <div aria-hidden className="absolute inset-0 bg-black/40 max-md:hidden" onClick={close} />
      <div
        ref={dialog}
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === "Tab") keepFocusIn(dialog.current, event.nativeEvent);
          else escapeCloses(onClose, busy)(event);
        }}
        className={cn(
          "relative flex flex-col overflow-hidden bg-background text-foreground",
          "max-md:h-full max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]",
          "md:absolute md:top-1/2 md:left-1/2 md:h-[min(40rem,calc(100dvh-4rem))] md:w-[min(36rem,calc(100vw-4rem))] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:border md:shadow-xl",
        )}
      >
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2 md:px-6 md:pt-4">
            <h2 id={titleId} className="min-w-0 flex-1 truncate text-base font-semibold">
              New workspace on {label}
            </h2>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close new workspace"
              title="Close (Esc)"
              disabled={busy}
              onClick={close}
            >
              <X />
            </Button>
          </div>
          <ol aria-label="Steps" className="grid shrink-0 grid-cols-2 gap-1 px-4 pb-3 md:grid-cols-4 md:px-6">
            {steps.map((title, index) => {
              const current = index === step;
              return (
                <li key={title} className="min-w-0">
                  <button
                    type="button"
                    aria-current={current ? "step" : undefined}
                    disabled={busy}
                    onClick={() => goTo(index)}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none",
                      current && "bg-secondary hover:bg-secondary",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "flex size-5 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
                        current ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground",
                      )}
                    >
                      {index + 1}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="text-xs font-medium">{title}</span>
                      <span className="truncate text-xs text-muted-foreground">{summaries[index]}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain border-t px-4 py-4 md:px-6">
            {step === 0 && (
              <>
                <ChoiceGroup
                  legend="What does the workspace folder hold?"
                  value={choice.source}
                  autoFocus
                  choices={sources.map((source) => ({
                    value: source,
                    label: sourceLabels[source],
                    description: sourceDescriptions[source],
                    problem: null,
                  }))}
                  onChange={(source) => choose({ source })}
                />
                {choice.source !== "none" && (
                  <ChoiceGroup
                    legend="How does the repository get there?"
                    value={choice.repository}
                    choices={repositoryKinds.map((kind) => ({
                      value: kind,
                      label: repositoryLabels[kind],
                      description: repositoryDescriptions[kind],
                      problem: repositoryProblem(choice.source, kind),
                    }))}
                    onChange={(repository) => choose({ repository })}
                  />
                )}
              </>
            )}
            {step === 1 && (
              <ChoiceGroup
                legend="When is a task done?"
                value={choice.completion}
                autoFocus
                choices={completions.map((completion) => ({
                  value: completion,
                  label: completionLabels[completion],
                  description: completionDescriptions[completion],
                  problem: completionProblem(choice.source, completion),
                }))}
                onChange={(completion) => choose({ completion })}
              />
            )}
            {step === 2 && (
              <div className="flex flex-col gap-2">
                <ChoiceGroup
                  legend="What does starting a task do?"
                  value={choice.runner}
                  autoFocus
                  choices={runners.map((runner) => ({
                    value: runner,
                    label: runnerLabels[runner],
                    description: runnerDescriptions[runner],
                    // Only a note: herdr can still be started before the first task is.
                    note: runner === "herdr" ? herdrNote : null,
                    // The machine is picked before the dialog opens, and the folder starts at its home,
                    // whose path tells a Windows host apart, so its rule comes first.
                    problem:
                      runnerLocationProblem(runner, { kind: machine === null ? "local" : "ssh", path }) ??
                      runnerProblem(choice.source, choice.completion, runner),
                  }))}
                  onChange={(runner) => choose({ runner })}
                />
                <p className="text-xs text-muted-foreground">
                  Which one fits?{" "}
                  <a
                    href={runnerGuideUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline underline-offset-2 hover:no-underline"
                  >
                    Compare the runners
                  </a>
                </p>
              </div>
            )}
            {last && (
              <div className="flex flex-col gap-3">
                {cloning && (
                  <Field label="Repository URL">
                    {({ id }) => (
                      <input
                        id={id}
                        className={inputClass}
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        required
                        autoFocus
                      />
                    )}
                  </Field>
                )}
                <Field label={cloning ? "Parent folder" : "Folder"} help={folderHelp}>
                  {({ id, describedBy }) => (
                    <FolderInput
                      id={id}
                      machine={target}
                      className={inputClass}
                      describedBy={describedBy}
                      value={folder}
                      onChange={setFolder}
                      required
                      autoFocus={!cloning}
                    />
                  )}
                </Field>
                <Field label="Name">
                  {({ id }) => (
                    <input
                      id={id}
                      className={inputClass}
                      value={effectiveName}
                      onChange={(e) => setName(e.target.value)}
                      required
                    />
                  )}
                </Field>
                {cloning && folder.trim() && effectiveName.trim() && (
                  <p className="truncate text-xs text-muted-foreground" title={path}>
                    Clones into {path}
                  </p>
                )}
                {choice.repository === "init" && (
                  <p className="text-xs text-muted-foreground">
                    The folder is created if it does not exist and becomes a git repository without a remote.
                  </p>
                )}
                {choice.source !== "none" && (
                  <Field
                    label="Base branch"
                    help={choice.repository === "init" ? "Uses main if empty." : "Detected from the repository if empty."}
                  >
                    {({ id, describedBy }) => (
                      <input
                        id={id}
                        className={inputClass}
                        aria-describedby={describedBy}
                        value={baseBranch}
                        onChange={(e) => setBaseBranch(e.target.value)}
                      />
                    )}
                  </Field>
                )}
                {createWorkspace.isError && (
                  <p role="alert" className="text-xs break-words text-destructive">
                    {createWorkspace.error.message}
                  </p>
                )}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2 border-t px-4 py-3 md:px-6">
            {step === 0 ? (
              <Button type="button" variant="ghost" disabled={busy} onClick={close}>
                Cancel
              </Button>
            ) : (
              <Button type="button" variant="ghost" disabled={busy} onClick={() => goTo(step - 1)}>
                <ChevronLeft data-icon="inline-start" />
                Back
              </Button>
            )}
            <Button type="submit" className="ml-auto" changesData={last} disabled={busy || (last && folderUntouched)}>
              {last ? (
                busy ? (
                  labels.pending
                ) : (
                  labels.submit
                )
              ) : (
                <>
                  Next
                  <ChevronRight data-icon="inline-end" />
                </>
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
