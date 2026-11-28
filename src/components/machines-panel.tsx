import { useEffect, useRef, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { AddMachine, ProblemText } from "@/components/add-machine";
import { Button } from "@/components/button";
import { ConfigEntryRow } from "@/components/dori-config-panel";
import { escapeCloses } from "@/components/workspace-list";
import { fill, useMessages } from "@/lib/i18n";
import {
  HOST_MACHINE,
  MACHINE_TOOLS,
  type MachineJob,
  type MachineRow,
  type MachineTool,
  type RunnerConfigView,
} from "@/lib/machines";
import type { Messages } from "@/locales/en";
import { useMachineJobAction, useMachineJobs, useMachines, useRunnerConfig, useSaveRunnerConfig } from "@/web/machines";

type Texts = Messages["settings"]["machines"];

const STATE_VARIANTS = { connected: "success", stale: "warning", offline: "neutral", lost: "error", revoked: "error" } as const;
const JOB_VARIANTS = { running: "info", succeeded: "success", failed: "error", cancelled: "neutral" } as const;

const machineName = (label: string, t: Texts) => (label === HOST_MACHINE ? t.host : label);
/** The machine inside a sentence: "this server" or the runner's label. */
const machineHere = (label: string, t: Texts) => (label === HOST_MACHINE ? t.here : label);

function ToolVersions({ row, t }: { row: MachineRow; t: Texts }) {
  if (row.tools === null) return row.toolsError ? <p className="break-words text-muted-foreground">{t.toolsUnknown(row.toolsError)}</p> : null;
  const tools = row.tools;
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-1">
      {MACHINE_TOOLS.map((tool) => (
        <span key={tool} className={tools[tool] === null ? "text-muted-foreground" : "font-mono text-xs leading-5"}>
          {tools[tool] === null ? t.notInstalled(tool) : `${tool} ${tools[tool]}`}
        </span>
      ))}
    </p>
  );
}

/** Install or update one tool on a machine, after a confirm step: the job runs a command there. */
function InstallButton({ machine, tool, installed, busy, t }: { machine: string; tool: MachineTool; installed: boolean; busy: boolean; t: Texts }) {
  const [confirming, setConfirming] = useState(false);
  const action = useMachineJobAction();
  const label = installed ? t.update(tool) : t.install(tool);
  if (!confirming) {
    return <Button size="sm" variant="secondary" label={label} isDisabled={busy} onClick={() => setConfirming(true)} />;
  }
  return (
    <div
      role="alertdialog"
      aria-label={label}
      className="flex basis-full flex-col gap-1 rounded-md border p-2"
      onKeyDown={escapeCloses(() => setConfirming(false), action.isPending)}
    >
      <p>{installed ? t.confirmUpdate(tool, machineHere(machine, t)) : t.confirmInstall(tool, machineHere(machine, t))}</p>
      <div className="flex gap-1">
        <Button
          changesData
          size="sm"
          variant="primary"
          label={t.run}
          isDisabled={action.isPending}
          onClick={() => action.mutate({ op: "install", machine, tool }, { onSuccess: () => setConfirming(false) })}
        />
        <Button size="sm" variant="ghost" label={t.back} autoFocus onClick={() => setConfirming(false)} />
      </div>
      {action.error && <p role="alert" className="break-words text-destructive">{action.error.message}</p>}
    </div>
  );
}

function SignInButton({ machine, busy, t }: { machine: string; busy: boolean; t: Texts }) {
  const [replace, setReplace] = useState(false);
  const action = useMachineJobAction();
  return (
    <div className="flex basis-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          changesData
          size="sm"
          variant="secondary"
          label={t.signIn}
          isDisabled={busy || action.isPending}
          onClick={() => action.mutate({ op: "login", machine, replace })}
        />
        <CheckboxInput label={t.replaceDevice(machineHere(machine, t))} value={replace} onChange={setReplace} />
      </div>
      {action.error && <p role="alert" className="break-words text-destructive">{action.error.message}</p>}
    </div>
  );
}

function RunnerConfig({ machine, t }: { machine: string; t: Texts }) {
  const config = useRunnerConfig(machine, true);
  const save = useSaveRunnerConfig(machine);
  const view: RunnerConfigView | undefined = config.data;
  const editable = view?.entries.filter((e) => e.access === "edit") ?? [];
  const others = view?.entries.filter((e) => e.access !== "edit") ?? [];
  const row = (entry: RunnerConfigView["entries"][number]) => (
    <ConfigEntryRow
      key={entry.key}
      entry={entry}
      readOnlyNote={t.machineOnly}
      save={async (value) => { await save(entry.key, value); return t.savedApplied; }}
    />
  );
  return (
    <div className="flex flex-col gap-3 pt-2">
      {config.isPending && <p className="text-muted-foreground">{t.loading}</p>}
      {config.error && <p role="alert" className="break-words text-destructive">{config.error.message}</p>}
      {view && (
        <>
          <p className="text-muted-foreground">{fill(t.configWhere, { path: <code className="break-all">{view.where}</code> })}</p>
          {!view.present && <p>{t.configAbsent}</p>}
          <ul aria-label={`${t.config} ${machine}`} className="flex flex-col gap-3">{editable.map(row)}</ul>
          {others.length > 0 && (
            <details>
              <summary className="cursor-pointer text-muted-foreground">{t.machineOnlyKeys(others.length)}</summary>
              <ul className="flex flex-col gap-3 pt-3">{others.map(row)}</ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function MachineCard({ row, jobs, t }: { row: MachineRow; jobs: readonly MachineJob[]; t: Texts }) {
  const [configOpen, setConfigOpen] = useState(false);
  const host = row.label === HOST_MACHINE;
  const busy = (tool: MachineTool) => jobs.some((job) => job.machine === row.label && job.tool === tool && job.state === "running");
  const meta = [row.os, row.version === null ? null : t.runnerVersion(row.version)].filter(Boolean).join(" \u00b7 ");
  return (
    <li aria-label={t.machine(machineName(row.label, t))} className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{machineName(row.label, t)}</span>
        {host && <span className="font-mono text-xs text-muted-foreground">{row.label}</span>}
        <Badge variant={STATE_VARIANTS[row.state]} label={t.states[row.state]} />
      </div>
      {meta && <p className="text-muted-foreground">{meta}</p>}
      <ToolVersions row={row} t={t} />
      {row.tools && row.jobsUnavailable === null && (
        <div className="flex flex-wrap gap-2">
          {MACHINE_TOOLS.map((tool) => (
            <InstallButton key={tool} machine={row.label} tool={tool} installed={row.tools?.[tool] != null} busy={busy(tool)} t={t} />
          ))}
          {row.tools.omo !== null && <SignInButton machine={row.label} busy={busy("omo")} t={t} />}
        </div>
      )}
      {row.tools && row.jobsUnavailable !== null && <p className="text-muted-foreground">{t.jobsUnavailable[row.jobsUnavailable]}</p>}
      {row.config ? (
        <details onToggle={(event) => setConfigOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer text-muted-foreground">{t.config}</summary>
          {configOpen && <RunnerConfig machine={row.label} t={t} />}
        </details>
      ) : (
        <p className="text-muted-foreground">{t.configElsewhere}</p>
      )}
    </li>
  );
}

function DeviceCodeBox({ job, t }: { job: MachineJob; t: Texts }) {
  const device = job.device!;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-primary/40 p-3">
      <p>{t.signInHow}</p>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div className="flex flex-col">
          <span className="text-muted-foreground">{t.userCode}</span>
          <span className="font-mono text-2xl font-semibold tracking-widest" aria-label={t.userCode}>{device.userCode}</span>
        </div>
        {device.matchingCode && (
          <div className="flex flex-col">
            <span className="text-muted-foreground">{t.matchingCode}</span>
            <span className="font-mono text-lg" aria-label={t.matchingCode}>{device.matchingCode}</span>
          </div>
        )}
      </div>
      <a href={device.url} target="_blank" rel="noreferrer" className="self-start font-medium text-primary underline underline-offset-2 break-all">
        {t.openSignIn}
      </a>
      <p role="status" className="text-muted-foreground">{t.waitingApproval}</p>
    </div>
  );
}

function JobCard({ job, t }: { job: MachineJob; t: Texts }) {
  const title = job.kind === "login" ? t.jobTitle.login : job.kind === "runner" ? t.jobTitle.runner(job.machine) : t.jobTitle.install(job.tool ?? "");
  const cancel = useMachineJobAction();
  const log = useRef<HTMLPreElement>(null);
  // The newest output is at the bottom: follow it while the job runs.
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [job.log]);
  return (
    <li aria-label={title} data-state={job.state} className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{title}</span>
        {job.kind !== "runner" && <span className="text-muted-foreground">{t.jobOn(machineHere(job.machine, t))}</span>}
        <Badge variant={JOB_VARIANTS[job.state]} label={t.jobStates[job.state]} />
        {job.exitCode !== null && job.state === "failed" && <span className="text-muted-foreground">{t.exitCode(job.exitCode)}</span>}
        {job.state === "running" && (
          <Button
            changesData
            size="sm"
            variant="ghost"
            className="ml-auto"
            label={t.stop}
            isDisabled={cancel.isPending}
            onClick={() => cancel.mutate({ op: "cancel", job: job.id })}
          />
        )}
      </div>
      {job.state === "running" && job.device && <DeviceCodeBox job={job} t={t} />}
      {job.state === "succeeded" && job.tool && job.version && <p role="status">{t.nowVersion(job.tool, job.version)}</p>}
      {job.state === "succeeded" && job.kind === "runner" && <p role="status">{t.runnerAdded(job.machine)}</p>}
      {job.state === "failed" && job.problem && (
        <div role="alert" className="flex flex-col gap-1 rounded-md border border-destructive/50 p-2">
          <ProblemText problem={{ code: job.problem }} t={t} />
        </div>
      )}
      <pre
        ref={log}
        aria-label={t.jobLog(title)}
        className="max-h-64 overflow-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre-wrap wrap-anywhere"
      >
        {job.log}
      </pre>
      {cancel.error && <p role="alert" className="break-words text-destructive">{cancel.error.message}</p>}
    </li>
  );
}

/**
 * Settings > Machines & accounts: the server host and every runner Dori knows, with their state
 * and hc's and omo's versions, each runner's settings, the jobs that install or update hc and
 * omo and sign omo in on the host or a runner, their logs streamed while they run, and adding another
 * computer as a runner (AddMachine). On a server without Dori
 * it is the Set up Dori entry (`setup`). It asks the server only while shown (`active`).
 */
export function MachinesPanel({ setup = false, active = false }: { setup?: boolean; active?: boolean }) {
  const m = useMessages();
  const t = m.settings.machines;
  const machines = useMachines(active && !setup);
  const jobs = useMachineJobs(active && !setup, machines.data?.jobs ?? []);
  const rows = machines.data?.machines ?? [];
  return (
    <section aria-label={m.settings.sections[setup ? "dori-setup" : "machines"]} className="flex flex-col gap-4 text-sm break-words-keep">
      <p className="text-muted-foreground">{setup ? t.setupIntro : t.intro}</p>
      {!setup && (
        <>
          {machines.isPending && <p className="text-muted-foreground">{t.loading}</p>}
          {machines.error && <p role="alert" className="break-words text-destructive">{machines.error.message}</p>}
          {machines.data && rows.length === 0 && <p className="text-muted-foreground">{t.empty}</p>}
          {rows.length > 0 && (
            <ul aria-label={t.list} className="flex flex-col gap-3">
              {rows.map((row) => <MachineCard key={row.label} row={row} jobs={jobs} t={t} />)}
            </ul>
          )}
          {jobs.length > 0 && (
            <div className="flex flex-col gap-2">
              <h4 className="font-medium">{t.jobs}</h4>
              <ul aria-label={t.jobs} className="flex flex-col gap-3">
                {jobs.map((job) => <JobCard key={job.id} job={job} t={t} />)}
              </ul>
            </div>
          )}
        </>
      )}
      {setup ? (
        <details open>
          <summary className="cursor-pointer text-muted-foreground">{m.settings.showHow}</summary>
          <p className="pt-2">{fill(t.how, { setup: <code>dori setup</code>, runner: <code>dori runner setup</code> })}</p>
        </details>
      ) : (
        <details>
          <summary className="cursor-pointer font-medium">{t.addMachine}</summary>
          <AddMachine />
        </details>
      )}
    </section>
  );
}
