import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ChevronRight, Play, RefreshCw, Square, TriangleAlert } from "lucide-react";
import { PathLabel } from "@/components/path-label";
import { Button } from "@/components/ui/button";
import { When } from "@/components/when";
import { escapeCloses } from "@/components/workspace-list";
import type { AgentAdapter, RunEvent, RunId, RunnerHealth, RunState, Task, TaskRun } from "@/lib/bindings";
import { normalizePath, shortPath } from "@/lib/paths";
import { useRunLog, useRunnerHealth, useStartPlainRun, useStopRun, useTaskRuns } from "@/lib/queries";
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
  ["settled", runStates.settled.label],
  ["exited", runStates.exited.label],
  ["failed", runStates.failed.label],
  ["cancelled", runStates.cancelled.label],
  ["unknown", runStates.unknown.label],
]);

function eventLabel(kind: string): string {
  return eventLabels.get(kind) ?? kind;
}

/**
 * The last event of `run`, passing over the one that only marks the state it ended in, which
 * its state chip already shows: e.g. the error of a failed run.
 */
function lastEvent(run: TaskRun, events: RunEvent[]): RunEvent | undefined {
  const last = events.at(-1);
  return last?.kind === run.state && events.length > 1 ? events.at(-2) : last;
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
 * The runs of a task of a plain workspace in its details, newest first: Claude or Codex run
 * by Toodo on the task's worktree, with the events and the ends of the output of the open
 * run. A task in progress starts a run while no run holds its worktree; a run that holds it
 * can be stopped. Runs send no events: Refresh reloads them, as do coming back to the window
 * and changes to the tasks, and they reload every few seconds while one is starting or running.
 * An agent whose CLI the server did not find cannot be picked.
 */
export function RunsPanel({ task }: { task: Task }) {
  const runs = useTaskRuns(task.id);
  const health = useRunnerHealth();
  const startRun = useStartPlainRun();
  const stopRun = useStopRun();
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
  const failure = startRun.error ?? stopRun.error;
  const missing = missingAgents(health.data);
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
                ? `Run ${holding.generation} may still hold the worktree, since its end was not seen; stop it to start another run.`
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
 * The open run: when and where it ran, how it ended, its events, and the ends of its stdout
 * and stderr. The state comes from the run list; the log is loaded again when that state
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
          <section aria-label="Events" className="flex min-w-0 flex-col gap-0.5">
            <h5 className="font-medium text-muted-foreground">Events</h5>
            <ol
              aria-label={`Events of run ${run.generation}`}
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 max-md:gap-y-1.5"
            >
              {log.data.events.map((event) => (
                <li key={event.sequence} className="col-span-full grid grid-cols-subgrid items-baseline">
                  <When at={event.observedAt} className="text-muted-foreground" />
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 font-medium" title={event.kind}>
                      {eventLabel(event.kind)}
                    </span>
                    {event.payload && (
                      <span className="min-w-0 truncate text-muted-foreground" title={event.payload}>
                        {event.payload}
                      </span>
                    )}
                  </span>
                </li>
              ))}
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
