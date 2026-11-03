import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  Check,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  Copy,
  Play,
  RefreshCw,
  SearchCheck,
  Square,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { PathLabel } from "@/components/path-label";
import { Button } from "@/components/ui/button";
import { When } from "@/components/when";
import { escapeCloses } from "@/components/workspace-list";
import type { AgentAdapter, RunEvent, RunId, RunnerHealth, RunState, Task, TaskRun } from "@/lib/bindings";
import { normalizePath, shortPath } from "@/lib/paths";
import { useReconcileRun, useRunLog, useRunnerHealth, useStartPlainRun, useStopRun, useTaskRuns } from "@/lib/queries";
import { toneChip, tonePanel, toneText, type Tone } from "@/lib/status-styles";
import { cn } from "@/lib/utils";

/** How each run state is named and coloured, in the tones of the status glossary. */
const runStates: Record<RunState, { label: string; tone: Tone }> = {
  reserved: { label: "Starting", tone: "info" },
  running: { label: "Running", tone: "info" },
  settled: { label: "Succeeded", tone: "success" },
  exited: { label: "Exited", tone: "attention" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Stopped", tone: "neutral" },
  unknown: { label: "Unknown", tone: "attention" },
};

/** A run in these states holds the task's worktree: it can be stopped, and no other run starts before it ends. */
const activeStates: readonly RunState[] = ["reserved", "running", "unknown"];

const adapters: readonly AgentAdapter[] = ["claude", "codex"];

const adapterLabels: Record<AgentAdapter, string> = { claude: "Claude", codex: "Codex" };

/** What the server says about each agent CLI it did not find on its `PATH`; empty while that is not known. */
function missingAgents(health: RunnerHealth | undefined): Map<AgentAdapter, string> {
  const missing = new Map<AgentAdapter, string>();
  for (const agent of health?.agents ?? []) {
    if (!agent.installed) {
      missing.set(
        agent.adapter,
        agent.message ?? `${agent.adapter} was not found on the server's PATH; install it there, then press Refresh.`,
      );
    }
  }
  return missing;
}

/** The agent CLI a run drove, by name. */
function adapterName(adapter: string | null): string {
  return adapter === "claude" || adapter === "codex" ? adapterLabels[adapter] : (adapter ?? "Agent");
}

/** Names of the events runs record; the event that marks the state a run ended in is named like the state. */
const eventLabels = new Map<string, string>([
  ["reserved", "Reserved"],
  ["launched", "Launched"],
  ["todo", "Todo list"],
  ["launch_failed", "Launch failed"],
  ["result", "Result"],
  ["result_error", "Agent error"],
  ["no_result", "No result"],
  ["stderr", "stderr"],
  ["exit", "Exit"],
  ["exit_after_result", "Exit after result"],
  ["timed_out", "Timed out"],
  ["stop_requested", "Stop requested"],
  ["server_restarted", "Server restarted"],
  ["agent_session", "Agent session"],
  ["observation_lost", "Observation lost"],
  ["remote_still_running", "Still running on its host"],
  ["remote_missing", "Not found on its host"],
  ["interrupted", "Interrupted"],
  ["credential_cleanup_failed", "Credentials not removed"],
  ["settled", runStates.settled.label],
  ["exited", runStates.exited.label],
  ["failed", runStates.failed.label],
  ["cancelled", runStates.cancelled.label],
  ["unknown", runStates.unknown.label],
]);

function eventLabel(kind: string): string {
  return eventLabels.get(kind) ?? kind;
}

/** The state of a step of an agent's todo list, as todo events record it. */
type TodoStatus = "pending" | "in_progress" | "completed";

/** A step of an agent's todo list, in the agent's words. */
type TodoItem = { text: string; status: TodoStatus };

/** How each step of a todo list is named and marked: the step in progress stands out, done ones recede. */
const todoStatuses: Record<TodoStatus, { label: string; icon: LucideIcon; marker: string; text: string }> = {
  pending: { label: "Pending", icon: Circle, marker: toneText.neutral, text: "" },
  in_progress: { label: "In progress", icon: CircleDot, marker: toneText.info, text: "font-medium" },
  completed: {
    label: "Done",
    icon: CircleCheck,
    marker: toneText.success,
    text: "text-muted-foreground line-through decoration-muted-foreground/60",
  },
};

function isTodoItem(item: unknown): item is TodoItem {
  if (typeof item !== "object" || item === null) return false;
  const { text, status } = item as Record<string, unknown>;
  return typeof text === "string" && typeof status === "string" && Object.hasOwn(todoStatuses, status);
}

/**
 * The steps of the todo list a todo event recorded, from its payload
 * `{"items":[{"text":...,"status":...}]}`; null for a payload of any other shape, which is shown
 * as it is.
 */
function todoItems(payload: string | null): TodoItem[] | null {
  if (payload === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // Not JSON: shown as it is, like the payloads of other events.
    return null;
  }
  const items = typeof parsed === "object" && parsed !== null && "items" in parsed ? parsed.items : null;
  return Array.isArray(items) && items.every(isTodoItem) ? items : null;
}

function stepsDone(items: TodoItem[]): number {
  return items.filter((item) => item.status === "completed").length;
}

/**
 * A todo list in a line: how many of its steps are done, and the step the agent is on, or
 * the one it takes next when none is in progress: e.g. `2/5 done; Now: Write the tests`.
 */
function todoSummary(items: TodoItem[]): string {
  if (items.length === 0) return "Empty";
  const now = items.find((item) => item.status === "in_progress");
  const next = items.find((item) => item.status === "pending");
  const step = now ? `Now: ${now.text}` : next ? `Next: ${next.text}` : "All done";
  return `${stepsDone(items)}/${items.length} done; ${step}`;
}

/** A todo list as text, a line for each step with its state: the tooltip of its event. */
function todoLines(items: TodoItem[]): string {
  return items.map((item) => `${todoStatuses[item.status].label}: ${item.text}`).join("\n");
}

/**
 * The last event of `run` that tells how it ended. Todo lists only show how far the agent got,
 * and the event that only marks the state it ended in is passed over too, since its state chip
 * already shows it: what remains is e.g. the error of a failed run.
 */
function lastEvent(run: TaskRun, events: RunEvent[]): RunEvent | undefined {
  const told = events.filter((event) => event.kind !== "todo");
  const last = told.at(-1);
  return last?.kind === run.state && told.length > 1 ? told.at(-2) : last;
}

/** How a run that went wrong ended stands out; a success or a stop does not. */
function outcomeStyle(state: RunState): string {
  const { tone } = runStates[state];
  return tone === "danger" || tone === "attention" ? tonePanel[tone] : "bg-muted";
}

function RunStateBadge({ state }: { state: RunState }) {
  const { label, tone } = runStates[state];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        toneChip[tone],
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full bg-current",
          (state === "reserved" || state === "running") && "motion-safe:animate-pulse",
        )}
      />
      {label}
    </span>
  );
}

/**
 * The runs of a task of a plain or tmux workspace in its details, newest first: Claude or
 * Codex run by Toodo on the task's worktree, on the server or the workspace's SSH machine,
 * with the events and the ends of the output of the open run, and the command that attaches
 * a terminal to an active tmux run. A task in progress starts a run while no run holds its
 * worktree; a run that holds it can be stopped, and one whose end was not seen can be
 * reconciled. Runs send no events: Refresh reloads them, as do coming back to the window and
 * changes to the tasks, and they reload every few seconds while one is starting or running.
 * An agent whose CLI the server did not find cannot be picked, unless the workspace is on an
 * SSH machine (`remote`), whose agent CLIs the server does not check.
 */
export function RunsPanel({ task, remote = false }: { task: Task; remote?: boolean }) {
  const runs = useTaskRuns(task.id);
  const health = useRunnerHealth();
  const startRun = useStartPlainRun();
  const stopRun = useStopRun();
  const reconcileRun = useReconcileRun();
  const id = useId();
  const [adapter, setAdapter] = useState<AgentAdapter>("claude");
  const [mcp, setMcp] = useState(true);
  // The run whose log is open: the newest until one is picked, none once it is closed.
  const [picked, setPicked] = useState<RunId | null | undefined>(undefined);
  const [stopping, setStopping] = useState<RunId | null>(null);
  // Only a refresh asked for shows as one: while a run is live, the runs also reload on their own.
  const [refreshing, setRefreshing] = useState(false);
  const newestFirst = [...(runs.data ?? [])].reverse();
  const openId = picked === undefined ? (newestFirst[0]?.id ?? null) : picked;
  const log = useRunLog(openId);
  const inProgress = task.status === "in_progress";
  const holding = newestFirst.find((run) => activeStates.includes(run.state));
  const failure = startRun.error ?? stopRun.error ?? reconcileRun.error;
  const missing = missingAgents(remote ? undefined : health.data);
  // A picked agent whose CLI the server lacks gives way to one it has; without both, none is picked.
  const installed = adapters.filter((value) => !missing.has(value));
  const chosen = installed.includes(adapter) ? adapter : (installed[0] ?? null);

  // Runs start only while the task is in progress; later the panel keeps showing the ones it had.
  if (!inProgress && runs.isSuccess && newestFirst.length === 0) {
    return null;
  }

  function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (chosen === null) return;
    // The new run, or the launch that failed, is the newest one now: open it.
    startRun.mutate({ taskId: task.id, adapter: chosen, mcp }, { onSettled: () => setPicked(undefined) });
  }

  function refresh() {
    setRefreshing(true);
    void Promise.all([runs.refetch(), openId !== null && log.refetch(), health.refetch()]).finally(() =>
      setRefreshing(false),
    );
  }

  return (
    <section aria-label="Runs" className="flex min-w-0 flex-col gap-1.5 text-xs">
      <div className="flex items-center gap-2">
        <h4 className="font-medium text-muted-foreground">
          Runs{newestFirst.length > 0 && ` (${newestFirst.length})`}
        </h4>
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          aria-label={`Refresh runs of #${task.id}`}
          title="Reload the runs, the log of the open run, and the agent CLIs found on the server"
          disabled={refreshing}
          onClick={refresh}
        >
          <RefreshCw className={cn(refreshing && "animate-spin")} />
          Refresh
        </Button>
      </div>
      {inProgress && (
        <form
          aria-label={`New run of #${task.id}`}
          aria-describedby={`${id}-about`}
          onSubmit={start}
          className="flex flex-col gap-2 rounded-lg border p-2"
        >
          <p id={`${id}-about`} className="text-muted-foreground">
            The agent works in the task's worktree, with the task's title, description, and criteria as its prompt.
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div role="group" aria-label="Agent" className="flex gap-0.5 max-md:gap-2">
              {adapters.map((value) => (
                <Button
                  key={value}
                  type="button"
                  size="xs"
                  variant={chosen === value ? "default" : "ghost"}
                  aria-pressed={chosen === value}
                  disabled={missing.has(value)}
                  title={missing.get(value)}
                  onClick={() => setAdapter(value)}
                >
                  {adapterLabels[value]}
                </Button>
              ))}
            </div>
            <label
              className="flex items-center gap-1.5 max-md:min-h-11"
              title="Give the agent Toodo's MCP tools, e.g. to read the task and leave notes; the token is only in the agent's environment"
            >
              <input type="checkbox" checked={mcp} onChange={(event) => setMcp(event.target.checked)} />
              Toodo MCP
            </label>
            <Button
              type="submit"
              size="xs"
              className="ml-auto"
              aria-label={`Start run of #${task.id}`}
              disabled={startRun.isPending || holding !== undefined || chosen === null}
            >
              <Play />
              {startRun.isPending ? "Starting..." : "Start run"}
            </Button>
          </div>
          {holding && (
            <p role="note" aria-label={`Why no run of #${task.id} starts`} className="text-muted-foreground">
              {holding.state === "unknown"
                ? `Run ${holding.generation} may still hold the worktree, since its end was not seen; reconcile it to check, or stop it, to start another run.`
                : `Run ${holding.generation} is still running; stop it, or wait until it ends, to start another run.`}
            </p>
          )}
          {!holding && chosen === null && (
            <p
              role="note"
              aria-label={`Why no run of #${task.id} starts`}
              className={cn("flex items-start gap-1.5", toneText.attention)}
            >
              <TriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0" />
              <span>
                Neither claude nor codex was found on the server's PATH; install one of them there, then press Refresh
                to start a run.
              </span>
            </p>
          )}
          {chosen !== null &&
            [...missing].map(([value, message]) => (
              <p
                key={value}
                role="note"
                aria-label={`Why ${adapterLabels[value]} is unavailable`}
                className={cn("flex items-start gap-1.5", toneText.attention)}
              >
                <TriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0" />
                <span>{message}</span>
              </p>
            ))}
        </form>
      )}
      {failure && (
        <p role="alert" className="break-words text-destructive">
          {failure.message}
        </p>
      )}
      {runs.isPending && <p className="text-muted-foreground">Loading runs...</p>}
      {runs.isError && (
        <p role="alert" className="break-words text-destructive">
          Failed to load runs: {runs.error.message}
        </p>
      )}
      {runs.isSuccess && newestFirst.length === 0 && <p className="text-muted-foreground">No runs yet.</p>}
      {newestFirst.length > 0 && (
        <ol aria-label={`Runs of #${task.id}`} className="flex min-w-0 flex-col divide-y rounded-lg border">
          {newestFirst.map((run) => {
            const open = run.id === openId;
            const name = `run ${run.generation}`;
            return (
              <li key={run.id} className="flex min-w-0 flex-col">
                <div className="flex min-w-0 items-center gap-1 p-1">
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={open ? `${id}-run-${run.id}` : undefined}
                    aria-label={`Run ${run.generation}, ${adapterName(run.adapter)}, ${runStates[run.state].label}`}
                    onClick={() => setPicked(open ? null : run.id)}
                    className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md px-1.5 py-1 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 max-md:min-h-11"
                  >
                    <ChevronRight
                      aria-hidden
                      className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
                    />
                    <RunStateBadge state={run.state} />
                    <span className="shrink-0 font-medium">Run {run.generation}</span>
                    <span className="min-w-0 truncate text-muted-foreground">{adapterName(run.adapter)}</span>
                    {/* A phone has no room for the time beside a Stop button: it goes under the state. */}
                    <When
                      at={run.endedAt ?? run.startedAt ?? run.createdAt}
                      className="ml-auto shrink-0 text-muted-foreground max-md:basis-full max-md:pl-5.5"
                    />
                  </button>
                  {run.state === "unknown" && stopping !== run.id && (
                    <Button
                      size="xs"
                      variant="outline"
                      changesData
                      aria-label={`Reconcile ${name} of #${task.id}`}
                      title="Check on its host whether the agent of this run still runs, or how it ended; it is not started again"
                      disabled={reconcileRun.isPending}
                      onClick={() => reconcileRun.mutate(run)}
                    >
                      <SearchCheck />
                      {reconcileRun.isPending && reconcileRun.variables.id === run.id ? "Reconciling..." : "Reconcile"}
                    </Button>
                  )}
                  {activeStates.includes(run.state) && stopping !== run.id && (
                    <Button
                      size="xs"
                      variant="outline"
                      aria-label={`Stop ${name} of #${task.id}`}
                      title="Stop the agent of this run"
                      onClick={() => {
                        stopRun.reset();
                        setStopping(run.id);
                      }}
                    >
                      <Square />
                      Stop
                    </Button>
                  )}
                </div>
                {stopping === run.id && (
                  <div
                    role="group"
                    aria-label={`Stop ${name} of #${task.id}?`}
                    className="flex flex-wrap items-center gap-2 px-2.5 pb-2"
                    onKeyDown={escapeCloses(() => setStopping(null), stopRun.isPending)}
                  >
                    <span className="min-w-0 flex-1 basis-48">
                      Stop {name}? Its agent is stopped if it still runs; the changes it made stay in the worktree.
                    </span>
                    <Button
                      size="xs"
                      variant="destructive"
                      changesData
                      aria-label={`Confirm stop ${name} of #${task.id}`}
                      disabled={stopRun.isPending}
                      onClick={() => stopRun.mutate(run, { onSettled: () => setStopping(null) })}
                    >
                      <Square />
                      {stopRun.isPending ? "Stopping..." : "Stop run"}
                    </Button>
                    {/* Focus lands on Back, under the pointer, so a double click cannot stop the run. */}
                    <Button size="xs" variant="ghost" autoFocus onClick={() => setStopping(null)}>
                      Back
                    </Button>
                  </div>
                )}
                {open && <RunDetails id={`${id}-run-${run.id}`} run={run} log={log} />}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/**
 * The open run: when and where it ran, how it ended, the agent's todo list, its events, and
 * the ends of its stdout and stderr. The state comes from the run list; the log is loaded again when that state
 * changes, so the two agree.
 */
function RunDetails({ id, run, log }: { id: string; run: TaskRun; log: ReturnType<typeof useRunLog> }) {
  const listed = run.state;
  useEffect(() => {
    if (log.data !== undefined && log.data.run.state !== listed) void log.refetch();
    // Only a change of the listed state asks for the log again.
  }, [listed]);
  const ended = listed !== "reserved" && listed !== "running";
  const last = log.data && ended ? lastEvent(run, log.data.events) : undefined;
  // Each todo event holds the whole list, so the last one is where the agent is.
  const lastTodo = log.data?.events.filter((event) => event.kind === "todo").at(-1);

  return (
    <div id={id} className="flex min-w-0 flex-col gap-2 border-t px-2.5 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
        {run.startedAt !== null && <When at={run.startedAt} prefix="Started " />}
        {run.endedAt !== null && <When at={run.endedAt} prefix="Ended " />}
        {run.providerRunRef !== null && <span className="font-mono">{run.providerRunRef}</span>}
        {run.checkoutPath !== null && (
          <PathLabel
            label={`worktree of run ${run.generation}`}
            full={normalizePath(run.checkoutPath)}
            short={shortPath(run.checkoutPath)}
            className="font-mono"
          />
        )}
      </div>
      {log.isPending && <p className="text-muted-foreground">Loading the log...</p>}
      {log.isError && (
        <p role="alert" className="break-words text-destructive">
          Failed to load the log of run {run.generation}: {log.error.message}
        </p>
      )}
      {last && (
        <div
          role="note"
          aria-label={`Last event of run ${run.generation}`}
          className={cn("flex min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5", outcomeStyle(listed))}
        >
          <span className="font-medium">{eventLabel(last.kind)}</span>
          {last.payload && <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words">{last.payload}</p>}
        </div>
      )}
      {log.data && (
        <>
          {log.data.attach !== null && <AttachCommand run={run} command={log.data.attach} />}
          {lastTodo && <TodoList run={run} event={lastTodo} />}
          <section aria-label="Events" className="flex min-w-0 flex-col gap-0.5">
            <h5 className="font-medium text-muted-foreground">Events</h5>
            <ol
              aria-label={`Events of run ${run.generation}`}
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 max-md:gap-y-1.5"
            >
              {log.data.events.map((event) => {
                // A todo list reads as a summary, with the whole list in its tooltip.
                const todo = event.kind === "todo" ? todoItems(event.payload) : null;
                const detail = todo ? todoSummary(todo) : event.payload;
                return (
                  <li key={event.sequence} className="col-span-full grid grid-cols-subgrid items-baseline">
                    <When at={event.observedAt} className="text-muted-foreground" />
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="shrink-0 font-medium" title={event.kind}>
                        {eventLabel(event.kind)}
                      </span>
                      {detail && (
                        <span
                          className="min-w-0 truncate text-muted-foreground"
                          title={todo ? todoLines(todo) : detail}
                        >
                          {detail}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
          <LogTail run={run} name="stdout" text={log.data.stdout} />
          <LogTail run={run} name="stderr" text={log.data.stderr} />
        </>
      )}
    </div>
  );
}

/**
 * The shell command that attaches a terminal to the tmux session of an active run, with a
 * button that copies it. It runs on the server, which reaches an SSH machine's session over
 * ssh.
 */
function AttachCommand({ run, command }: { run: TaskRun; command: string }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  return (
    <section aria-label="Attach in a terminal" className="flex min-w-0 flex-col gap-0.5">
      <h5 className="font-medium text-muted-foreground">Attach in a terminal</h5>
      <div className="flex min-w-0 items-center gap-2 rounded-md bg-muted py-1 pr-1 pl-2">
        <code aria-label={`Attach command of run ${run.generation}`} className="min-w-0 flex-1 font-mono break-all">
          {command}
        </code>
        <Button
          size="xs"
          variant="outline"
          aria-label={`Copy the attach command of run ${run.generation}`}
          onClick={() => void copyCommand()}
        >
          {copy === "copied" ? <Check /> : <Copy />}
          Copy
        </Button>
      </div>
      <p className="text-muted-foreground">
        Run it on the Toodo server, as the user that runs Toodo, to watch the agent work.
        <span role="status" className={cn(copy === "failed" ? "ml-1 text-destructive" : "sr-only")}>
          {copy === "copied" ? "Copied" : copy === "failed" ? "Could not copy" : ""}
        </span>
      </p>
    </section>
  );
}

/**
 * The agent's todo list as the last todo event of a run recorded it, each step with its state;
 * the events keep the lists before it. A payload of any other shape is shown as it is.
 */
function TodoList({ run, event }: { run: TaskRun; event: RunEvent }) {
  const items = todoItems(event.payload);
  return (
    <section aria-label={`Todo list of run ${run.generation}`} className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <h5 className="font-medium text-muted-foreground">
          Todo list{items !== null && items.length > 0 && ` (${stepsDone(items)} of ${items.length} done)`}
        </h5>
        <When at={event.observedAt} prefix="Updated " className="ml-auto text-muted-foreground" />
      </div>
      {items === null ? (
        <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">
          {event.payload}
        </p>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground">The todo list is empty.</p>
      ) : (
        <ol className="flex min-w-0 flex-col gap-0.5 max-md:gap-1">
          {items.map((item, index) => {
            const { label, icon: Icon, marker, text } = todoStatuses[item.status];
            return (
              // Steps have no ids: each event holds the whole list, in the agent's order.
              <li key={index} className="flex min-w-0 gap-1.5">
                {/* One line high, so the marker stays by the first line of a step that wraps. */}
                <span role="img" aria-label={label} className={cn("flex h-lh shrink-0 items-center", marker)}>
                  <Icon aria-hidden className="size-3.5" />
                </span>
                <span className={cn("min-w-0 break-words-keep", text)}>{item.text}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/**
 * The end of the stdout or stderr of a run, scrolled to its last line. As a live run's output
 * grows, the view follows it, unless it was scrolled up to read, until it is back at the end.
 */
function LogTail({ run, name, text }: { run: TaskRun; name: "stdout" | "stderr"; text: string }) {
  const pre = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);
  useEffect(() => {
    if (pre.current !== null && atEnd.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [text]);

  return (
    <section aria-label={name} className="flex min-w-0 flex-col gap-0.5">
      <h5 className="font-mono font-medium text-muted-foreground">{name}</h5>
      {text === "" ? (
        <p className="text-muted-foreground">No output.</p>
      ) : (
        <pre
          ref={pre}
          onScroll={(event) => {
            const { scrollHeight, clientHeight, scrollTop } = event.currentTarget;
            atEnd.current = Math.abs(scrollHeight - clientHeight - scrollTop) <= 1;
          }}
          // Scrollable, so it takes the focus to scroll with the keyboard.
          tabIndex={0}
          aria-label={`${name} of run ${run.generation}`}
          className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap break-words outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {text}
        </pre>
      )}
    </section>
  );
}
