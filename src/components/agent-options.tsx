import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { compactSelectClass, inputClass } from "@/components/workspace-list";
import type { AgentOptions, PermissionMode, Task, Workspace } from "@/lib/bindings";
import {
  useSetTaskAgentOptions,
  useSetWorkspaceAgentOptions,
  useTaskAgentOptions,
  useWorkspaceAgentOptions,
} from "@/lib/queries";
import { cn } from "@/lib/utils";

const defaultTimeLimitMinutes = 240;
const maxTimeLimitMinutes = 7 * 24 * 60;

const permissionLabels: Record<PermissionMode, string> = {
  read_only: "Read only",
  edit: "Edit files",
  bypass: "Bypass checks",
};

const permissionTitles: Record<PermissionMode, string> = {
  read_only: "Read and plan only: Claude plan mode, Codex read-only sandbox",
  edit: "Edit files in the worktree: Claude acceptEdits, Codex --full-auto",
  bypass: "Anything, without permission checks or a sandbox",
};

const agentDefaultPermission = "Agent default (Claude bypass, Codex edit)";

/** What a field left blank means: the workspace's value for a task, the built-in default for a workspace. */
type Fallback = { model: string; permission: string; minutes: string };

const builtIn: Fallback = {
  model: "Agent default",
  permission: agentDefaultPermission,
  minutes: `${defaultTimeLimitMinutes} min`,
};

function fallbackFrom(workspace: AgentOptions): Fallback {
  return {
    model: workspace.model ?? builtIn.model,
    permission: workspace.permissionMode ? permissionLabels[workspace.permissionMode] : builtIn.permission,
    minutes: workspace.timeLimitMinutes !== null ? `${workspace.timeLimitMinutes} min` : builtIn.minutes,
  };
}

function summary(options: AgentOptions, fallback: Fallback): string {
  return [
    options.model ?? fallback.model,
    options.permissionMode ? permissionLabels[options.permissionMode] : fallback.permission,
    options.timeLimitMinutes !== null ? `${options.timeLimitMinutes} min` : fallback.minutes,
  ].join(", ");
}

/** The time limit typed, `null` for blank, or `undefined` for one that is not a whole number of minutes in range. */
function parseMinutes(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const minutes = Number(trimmed);
  return minutes >= 1 && minutes <= maxTimeLimitMinutes ? minutes : undefined;
}

function AgentOptionsForm({
  label,
  saved,
  fallback,
  pending,
  error,
  onSave,
  onClose,
}: {
  label: string;
  saved: AgentOptions;
  fallback: Fallback;
  pending: boolean;
  error: Error | null;
  onSave: (options: AgentOptions) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [model, setModel] = useState(saved.model ?? "");
  const [permission, setPermission] = useState<PermissionMode | "">(saved.permissionMode ?? "");
  const [minutes, setMinutes] = useState(saved.timeLimitMinutes?.toString() ?? "");
  const timeLimit = parseMinutes(minutes);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (timeLimit === undefined) return;
    onSave({ model: model.trim() === "" ? null : model.trim(), permissionMode: permission || null, timeLimitMinutes: timeLimit });
  }

  return (
    <form aria-label={label} onSubmit={submit} className="flex flex-col gap-2 rounded-lg border p-2 text-sm">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Model</span>
          <input
            className={cn(inputClass, "w-44")}
            value={model}
            placeholder={fallback.model}
            maxLength={100}
            onChange={(event) => setModel(event.target.value)}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Permission mode</span>
          <select
            className={cn(compactSelectClass, "max-w-72")}
            value={permission}
            onChange={(event) => setPermission(event.target.value as PermissionMode | "")}
          >
            <option value="">{fallback.permission}</option>
            {(Object.keys(permissionLabels) as PermissionMode[]).map((mode) => (
              <option key={mode} value={mode} title={permissionTitles[mode]}>
                {permissionLabels[mode]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Time limit (minutes, plain runs)</span>
          <input
            className={cn(inputClass, "w-28")}
            inputMode="numeric"
            value={minutes}
            placeholder={fallback.minutes}
            aria-invalid={timeLimit === undefined}
            aria-describedby={timeLimit === undefined ? `${id}-minutes` : undefined}
            onChange={(event) => setMinutes(event.target.value)}
          />
        </label>
      </div>
      {timeLimit === undefined && (
        <p id={`${id}-minutes`} className="text-xs text-destructive">
          Give a whole number of minutes from 1 to {maxTimeLimitMinutes}, or leave it blank.
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" size="xs" disabled={pending || timeLimit === undefined}>
          {pending ? "Saving..." : "Save"}
        </Button>
        <Button type="button" size="xs" variant="ghost" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
        {error && (
          <span role="alert" className="min-w-0 break-words text-xs text-destructive">
            {error.message}
          </span>
        )}
      </div>
    </form>
  );
}

export function WorkspaceAgentOptions({ workspace }: { workspace: Workspace }) {
  const options = useWorkspaceAgentOptions(workspace.id);
  const save = useSetWorkspaceAgentOptions();
  const [editing, setEditing] = useState(false);

  if (editing && options.data) {
    return (
      <AgentOptionsForm
        label={`Agent options of ${workspace.name}`}
        saved={options.data}
        fallback={builtIn}
        pending={save.isPending}
        error={save.error}
        onSave={(next) =>
          save.mutate({ workspace: workspace.id, options: next }, { onSuccess: () => setEditing(false) })
        }
        onClose={() => setEditing(false)}
      />
    );
  }
  return (
    <p className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
      <span className="shrink-0">Agents</span>
      <span aria-label="Agent options" className="min-w-0 truncate text-foreground">
        {options.data ? summary(options.data, builtIn) : options.isError ? options.error.message : "Loading..."}
      </span>
      <Button
        size="xs"
        variant="ghost"
        aria-label="Change agent options"
        title="The model, permission mode, and time limit runs of this workspace's tasks start with"
        disabled={!options.data}
        onClick={() => {
          save.reset();
          setEditing(true);
        }}
      >
        Change
      </Button>
    </p>
  );
}

export function TaskAgentOptions({ task }: { task: Task }) {
  const options = useTaskAgentOptions(task.id);
  const save = useSetTaskAgentOptions();
  const [editing, setEditing] = useState(false);
  const fallback = options.data ? fallbackFrom(options.data.workspace) : builtIn;

  if (editing && options.data) {
    return (
      <AgentOptionsForm
        label={`Agent options of #${task.id}`}
        saved={options.data.task}
        fallback={fallback}
        pending={save.isPending}
        error={save.error}
        onSave={(next) => save.mutate({ taskId: task.id, options: next }, { onSuccess: () => setEditing(false) })}
        onClose={() => setEditing(false)}
      />
    );
  }
  return (
    <p className="flex min-w-0 items-center gap-1 text-muted-foreground">
      <span className="shrink-0">Runs with</span>
      <span aria-label={`Agent options of #${task.id}`} className="min-w-0 truncate text-foreground">
        {options.data ? summary(options.data.task, fallback) : options.isError ? options.error.message : "Loading..."}
      </span>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label={`Change agent options of #${task.id}`}
        title="Override the model, permission mode, and time limit the workspace sets, for this task's runs"
        disabled={!options.data}
        onClick={() => {
          save.reset();
          setEditing(true);
        }}
      >
        Change
      </Button>
    </p>
  );
}
