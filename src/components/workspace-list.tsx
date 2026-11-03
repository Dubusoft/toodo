import { useId, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Laptop, Plus, Server, TriangleAlert, X } from "lucide-react";
import { RemoteFolderBrowser, joinPath } from "@/components/remote-folder-browser";
import { Button } from "@/components/ui/button";
import type {
  HerdrMachine,
  PathProblem,
  Workspace,
  WorkspaceId,
  WorkspaceLocation,
  WorkspaceSource,
} from "@/lib/bindings";
import { normalizePath, shortPath } from "@/lib/paths";
import {
  useCreateWorkspace,
  useDeleteWorkspace,
  useHerdrMachines,
  useHomeDirectory,
  useMoveWorkspace,
  useWorkspaces,
} from "@/lib/queries";
import { cn } from "@/lib/utils";
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

/** SSH host of a herdr machine, or `null` for this computer. */
type MachineKey = string | null;

type Mode = WorkspaceSource["kind"];

/**
 * How each way of adding a workspace on a machine is offered and submitted. The buttons are
 * text only, so the three of them leave room for the machine name in the narrow sidebar.
 */
const modes: Record<Mode, { label: string; title: string; submit: string; pending: string }> = {
  clone: { label: "Clone", title: "Clone a repository", submit: "Clone workspace", pending: "Cloning..." },
  open: { label: "Open", title: "Open a cloned repository", submit: "Open workspace", pending: "Opening..." },
  init: {
    label: "Init",
    title: "Make a folder a new git repository",
    submit: "Init workspace",
    pending: "Initializing...",
  },
};

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
  const [adding, setAdding] = useState<{ machine: MachineKey; mode: Mode } | null>(null);
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

      {addingMachine && <AddMachineHelp onClose={() => setAddingMachine(false)} />}
      {herdrMachines.isError && (
        <p role="alert" className="text-xs text-destructive">
          Failed to list herdr machines: {herdrMachines.error.message}
        </p>
      )}
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
            const active = adding?.machine === machine ? adding.mode : null;
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
                  {(["clone", "open", "init"] as const).map((mode) => (
                    <Button
                      key={mode}
                      size="xs"
                      variant={active === mode ? "secondary" : "outline"}
                      aria-label={`${modes[mode].label} on ${label}`}
                      aria-pressed={active === mode}
                      title={modes[mode].title}
                      onClick={() => setAdding(active === mode ? null : { machine, mode })}
                    >
                      {modes[mode].label}
                    </Button>
                  ))}
                </div>
                {active && (
                  <NewWorkspaceForm
                    key={active}
                    machine={machine}
                    mode={active}
                    onCreated={(workspace) => {
                      setAdding(null);
                      onSelect(workspace.id);
                    }}
                    onCancel={() => setAdding(null)}
                  />
                )}
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
  const [browsing, setBrowsing] = useState(false);
  const remotes = [
    ...new Set([
      ...(herdrMachines.data ?? []).map((saved) => saved.target),
      ...(workspaces.data ?? []).flatMap((w) => (w.location.kind === "ssh" ? [w.location.machine] : [])),
    ]),
  ];
  const path = folder.trim();

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
            onChange={(e) => {
              setMachine(e.target.value === "" ? null : e.target.value);
              setBrowsing(false);
            }}
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
          <div className="flex gap-1">
            <input
              id={id}
              className={inputClass}
              aria-describedby={describedBy}
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              required
            />
            <Button type="button" size="sm" variant="outline" onClick={() => setBrowsing((open) => !open)} aria-expanded={browsing}>
              Browse...
            </Button>
          </div>
        )}
      </Field>
      {browsing && (
        <RemoteFolderBrowser
          key={machine ?? ""}
          machine={machine === null ? { kind: "local" } : { kind: "ssh", label: machine }}
          initialPath=""
          onSelect={(picked) => {
            setFolder(picked);
            setBrowsing(false);
          }}
          onCancel={() => setBrowsing(false)}
        />
      )}
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

const ADD_MACHINE_COMMAND = "herdr machine add <host>";

/** The server cannot open a terminal for `herdr machine add`, so the user runs it on the server. */
function AddMachineHelp({ onClose }: { onClose: () => void }) {
  const [notice, setNotice] = useState<string | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(ADD_MACHINE_COMMAND);
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
        herdr asks questions in a terminal, which the Toodo server cannot open. Run this command in a terminal on the
        server, replacing <code>&lt;host&gt;</code> with an SSH host from its ~/.ssh/config, then reload the machine
        list here.
      </p>
      <div className="flex flex-col items-start gap-1">
        <code className="max-w-full rounded bg-muted px-1.5 py-1 text-xs" aria-label="Add machine command">
          {ADD_MACHINE_COMMAND}
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

type NewWorkspaceFormProps = {
  machine: MachineKey;
  mode: Mode;
  onCreated: (workspace: Workspace) => void;
  onCancel: () => void;
};

function NewWorkspaceForm({ machine, mode, onCreated, onCancel }: NewWorkspaceFormProps) {
  const createWorkspace = useCreateWorkspace();
  const [url, setUrl] = useState("");
  const [folderDraft, setFolder] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [baseBranch, setBaseBranch] = useState("");
  const [browsing, setBrowsing] = useState(false);

  const cloning = mode === "clone";
  const home = useHomeDirectory(machine === null ? { kind: "local" } : { kind: "ssh", label: machine }).data;
  // A clone makes a new folder under home. Open and Init name the repository's own folder,
  // so they start inside home, and the folder has to be finished before submitting.
  const startFolder = home === undefined ? "" : cloning ? home : withSeparator(home);
  const folder = folderDraft ?? startFolder;
  const folderUntouched = !cloning && folderDraft === null;
  const effectiveName = name ?? (cloning ? repositoryName(url) : folderUntouched ? "" : baseName(folder));
  const folderLabel = cloning ? "Parent folder" : "Folder";
  const path =
    cloning && folder.trim() && effectiveName.trim() ? joinPath(folder.trim(), effectiveName.trim()) : folder.trim();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const location: WorkspaceLocation =
      machine === null ? { kind: "local", path } : { kind: "ssh", machine, path };
    const source: WorkspaceSource = mode === "clone" ? { kind: "clone", url } : { kind: mode };
    createWorkspace.mutate(
      { name: effectiveName, location, source, defaultBaseBranch: baseBranch.trim() || null },
      { onSuccess: onCreated },
    );
  }

  return (
    <form
      onSubmit={submit}
      aria-label={`${modes[mode].label} workspace on ${machine ?? "Local"}`}
      className="flex flex-col gap-2 rounded-lg border p-2"
      onKeyDown={escapeCloses(onCancel, createWorkspace.isPending)}
    >
      {cloning && (
        <Field label="Repository URL">
          {({ id }) => (
            <input
              id={id}
              className={inputClass}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          )}
        </Field>
      )}
      <Field label={folderLabel} help={cloning ? undefined : "The repository's own folder."}>
        {({ id, describedBy }) => (
          <div className="flex gap-1">
            <input
              id={id}
              className={inputClass}
              aria-describedby={describedBy}
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              required
            />
            <Button type="button" size="sm" variant="outline" onClick={() => setBrowsing((open) => !open)} aria-expanded={browsing}>
              Browse...
            </Button>
          </div>
        )}
      </Field>
      {browsing && (
        <RemoteFolderBrowser
          machine={machine === null ? { kind: "local" } : { kind: "ssh", label: machine }}
          initialPath={folder}
          onSelect={(picked) => {
            setFolder(picked);
            setBrowsing(false);
          }}
          onCancel={() => setBrowsing(false)}
        />
      )}
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
      {cloning && folder.trim() && effectiveName.trim() && <p className="truncate text-xs text-muted-foreground" title={path}>Clones into {path}</p>}
      {mode === "init" && (
        <p className="text-xs text-muted-foreground">
          The folder is created if it does not exist and becomes a git repository without a remote.
        </p>
      )}
      <Field label="Base branch" help={mode === "init" ? "Uses main if empty." : "Detected from the repository if empty."}>
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
      {createWorkspace.isError && (
        <p role="alert" className="text-xs text-destructive">
          {createWorkspace.error.message}
        </p>
      )}
      <Button type="submit" size="sm" disabled={createWorkspace.isPending || folderUntouched}>
        {createWorkspace.isPending ? modes[mode].pending : modes[mode].submit}
      </Button>
    </form>
  );
}
