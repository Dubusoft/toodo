/**
 * Settings > Machines & accounts' calls: `GET /api/machines` lists the machines and the latest
 * jobs, `GET /api/machines/<label>/config` reads a runner's runner-config.json, `POST
 * /api/machines` changes a key, starts a job, pre-checks a computer to add or makes its enrollment
 * command, and `GET /api/machines/jobs` streams each job's state while it runs, so its log grows on
 * screen as the supervisor reads it.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMessages } from "@/lib/i18n";
import {
  MACHINE_JOB_EVENT,
  type MachineJob,
  type MachineOp,
  type MachineRequest,
  type MachineResults,
  type RunnerConfigView,
} from "@/lib/machines";
import type { Messages } from "@/locales/en";
import { serverFetch } from "@/web/connection";
import { parseServerSentEvents } from "@/web/event";
import { credentials, forgetToken, rejectedByServer } from "@/web/session";

const MACHINES_PATH = "/api/machines";
const machinesKey = ["machines"] as const;
const configKey = (machine: string) => ["machines", machine, "config"] as const;
/** Runner states and versions move on their own while the section is open. */
const REFRESH_MS = 30_000;
/** While a pasted enrollment waits for its computer to connect. */
const WAITING_REFRESH_MS = 5_000;
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

type Texts = Messages["settings"]["machines"];

async function call<O extends MachineOp>(t: Texts, path: string, request?: MachineRequest & { op: O }): Promise<MachineResults[O]> {
  const signedIn = credentials();
  if (signedIn === null) throw new Error(t.noToken);
  const response = await serverFetch(
    path,
    request === undefined
      ? { headers: signedIn }
      : { method: "POST", headers: { ...signedIn, "content-type": "application/json" }, body: JSON.stringify(request) },
  );
  if (await rejectedByServer(response)) forgetToken();
  const body: unknown = await response.json().catch(() => null);
  if (typeof body === "object" && body !== null && "ok" in body) {
    if (body.ok === true) return body as unknown as MachineResults[O];
    if ("error" in body && typeof body.error === "string") throw new Error(body.error);
  }
  const message = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? `: ${body.message}` : "";
  throw new Error(t.requestFailed(response.status, message));
}

/**
 * Every machine with hc's and omo's versions, and the latest jobs, fetched while `active`, and
 * more often while `waiting` for a new computer to connect.
 */
export function useMachines(active: boolean, waiting = false) {
  const t = useMessages().settings.machines;
  return useQuery({
    queryKey: machinesKey,
    queryFn: () => call<"list">(t, MACHINES_PATH),
    enabled: active,
    refetchInterval: active ? (waiting ? WAITING_REFRESH_MS : REFRESH_MS) : false,
  });
}

/** Checks an ssh target before a runner is installed there. */
export function usePrecheck() {
  const t = useMessages().settings.machines;
  return useMutation({
    mutationFn: async (request: MachineRequest & { op: "precheck" }) => (await call<"precheck">(t, MACHINES_PATH, request)).precheck,
  });
}

/** Issues a one-time enrollment code for a computer that pastes the command. */
export function useEnrollCode() {
  const t = useMessages().settings.machines;
  return useMutation({
    mutationFn: async (request: MachineRequest & { op: "enroll-code" }) => (await call<"enroll-code">(t, MACHINES_PATH, request)).enrollment,
  });
}

/** A runner's runner-config.json, fetched once it is opened. */
export function useRunnerConfig(machine: string, enabled: boolean) {
  const t = useMessages().settings.machines;
  return useQuery({
    queryKey: configKey(machine),
    queryFn: async () => (await call<"config">(t, `${MACHINES_PATH}/${encodeURIComponent(machine)}/config`)).config,
    enabled,
    retry: false,
  });
}

/** Saves one runner-config key ("" unsets it); the answer replaces the cached file. */
export function useSaveRunnerConfig(machine: string) {
  const t = useMessages().settings.machines;
  const queryClient = useQueryClient();
  return async (key: string, value: string): Promise<RunnerConfigView> => {
    const { config } = await call<"config-set">(t, MACHINES_PATH, { op: "config-set", machine, key, value });
    queryClient.setQueryData(configKey(machine), config);
    return config;
  };
}

/**
 * Starts an install, a sign-in or a runner install over ssh, answers a sign-in, or cancels a
 * job; the answer is the job as it stands.
 */
export function useMachineJobAction() {
  const t = useMessages().settings.machines;
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: MachineRequest & { op: "install" | "login" | "login-answer" | "cancel" | "add-ssh" }) =>
      (await call<typeof request.op>(t, MACHINES_PATH, request)).job,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: machinesKey }),
  });
}

async function follow(signal: AbortSignal, t: Texts, onJob: (job: MachineJob) => void): Promise<void> {
  const signedIn = credentials();
  if (signedIn === null) throw new Error(t.noToken);
  const response = await serverFetch(`${MACHINES_PATH}/jobs`, { headers: signedIn, signal });
  if (await rejectedByServer(response)) forgetToken();
  if (!response.ok || response.body === null) throw new Error(t.requestFailed(response.status, ""));
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    const parsed = parseServerSentEvents(buffer + value);
    buffer = parsed.rest;
    for (const event of parsed.events) {
      if (event.event === MACHINE_JOB_EVENT) onJob(JSON.parse(event.data) as MachineJob);
    }
  }
}

/**
 * The jobs, newest first: those the list answered with, replaced by each newer state the job
 * stream sends while `active`. A dropped stream reconnects after a growing delay.
 */
export function useMachineJobs(active: boolean, listed: readonly MachineJob[]): MachineJob[] {
  const t = useMessages().settings.machines;
  const [streamed, setStreamed] = useState<ReadonlyMap<string, MachineJob>>(new Map());
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void (async () => {
      let delay = FIRST_RETRY_MS;
      while (!controller.signal.aborted) {
        try {
          await follow(controller.signal, t, (job) => {
            delay = FIRST_RETRY_MS;
            setStreamed((previous) => new Map(previous).set(job.id, job));
            // A job that ended may have changed a version the list shows.
            if (job.state !== "running") void queryClient.invalidateQueries({ queryKey: machinesKey });
          });
        } catch {
          if (controller.signal.aborted) return;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, MAX_RETRY_MS);
      }
    })();
    return () => controller.abort();
  }, [active, t, queryClient]);
  const byId = new Map(listed.map((job) => [job.id, job]));
  for (const [id, job] of streamed) {
    const known = byId.get(id);
    // The list may be newer than the stream's last update when the stream reconnected late.
    if (known === undefined || known.state === "running" || job.state !== "running") byId.set(id, job);
  }
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
}
