/**
 * Follows the Dori status panel's stream (`GET /api/supervisor/status`) while a panel is
 * shown: the server sends the supervisor's latest snapshot first and then each new one. The
 * supervisor reads lane screens and the quota only while some panel follows the stream, so
 * the stream is open only while `active`. A dropped stream reconnects after a growing delay.
 */
import { useEffect, useState } from "react";
import { useMessages } from "@/lib/i18n";
import type { Messages } from "@/locales/en";
import { SUPERVISOR_STATUS_EVENT, type SupervisorStatusSnapshot } from "@/lib/supervisor-status";
import { serverFetch } from "@/web/connection";
import { parseServerSentEvents } from "@/web/event";
import { credentials, forgetToken, rejectedByServer } from "@/web/session";

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

export type SupervisorStatusState = {
  /** The latest snapshot, kept while the stream reconnects; `null` before the first. */
  snapshot: SupervisorStatusSnapshot | null;
  /** Why the stream is down, while it is; `null` while it is open or opening. */
  error: string | null;
};

class StatusStreamError extends Error {
  constructor(readonly display: (m: Messages) => string) { super(); }
}

async function follow(signal: AbortSignal, onSnapshot: (snapshot: SupervisorStatusSnapshot) => void): Promise<void> {
  const signedIn = credentials();
  if (signedIn === null) throw new StatusStreamError((m) => m.settings.schedules.noToken);
  const response = await serverFetch("/api/supervisor/status", { headers: signedIn, signal });
  if (await rejectedByServer(response)) forgetToken();
  if (!response.ok || response.body === null) throw new StatusStreamError((m) => m.settings.supervisorPanel.streamFailed(response.status));
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new StatusStreamError((m) => m.settings.supervisorPanel.streamEnded);
    const parsed = parseServerSentEvents(buffer + value);
    buffer = parsed.rest;
    for (const event of parsed.events) {
      if (event.event === SUPERVISOR_STATUS_EVENT) onSnapshot(JSON.parse(event.data) as SupervisorStatusSnapshot);
    }
  }
}

export function useSupervisorStatus(active: boolean): SupervisorStatusState {
  const m = useMessages();
  const [state, setState] = useState<Omit<SupervisorStatusState, "error"> & { error: unknown }>({ snapshot: null, error: null });
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void (async () => {
      let delay = FIRST_RETRY_MS;
      while (!controller.signal.aborted) {
        try {
          await follow(controller.signal, (snapshot) => {
            delay = FIRST_RETRY_MS;
            setState({ snapshot, error: null });
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          setState((previous) => ({ ...previous, error }));
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, MAX_RETRY_MS);
      }
    })();
    return () => controller.abort();
  }, [active]);
  const { error, snapshot } = state;
  return { snapshot, error: error instanceof StatusStreamError ? error.display(m) : error instanceof Error ? error.message : error === null ? null : String(error) };
}
