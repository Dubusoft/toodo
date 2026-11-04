/**
 * The logs of a plain or tmux run, streamed from `toodo-server` over
 * `GET /api/runs/{id}/log` (server-sent events): the end of each log first, then what the
 * agent writes, until the run ended. When the stream drops, it reconnects with the id of
 * the last event, and the server goes on from there.
 */
import { serverFetch } from "@/web/connection";
import { parseServerSentEvents } from "@/web/event";
import { authorization, failureMessage, getToken } from "@/web/session";

export type RunLogName = "stdout" | "stderr";

/** New text of a log, from byte `offset` to byte `next` of it. */
export type RunLogChunk = { stream: RunLogName; offset: number; next: number; text: string };

export type RunLogHandlers = {
  onChunk: (chunk: RunLogChunk) => void;
  /** The run ended and all of both logs was sent. */
  onEnd: () => void;
  /** A read failed; the stream goes on trying, or gave up when the server refused it. */
  onError: (message: string) => void;
};

const RETRY_MS = 2000;

/** Follows the logs of run `runId`; returns a function that stops following them. */
export function followRunLog(runId: number, handlers: RunLogHandlers): () => void {
  const controller = new AbortController();
  let lastId: string | null = null;
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        const token = getToken();
        const headers = {
          ...(token === null ? {} : authorization(token)),
          ...(lastId === null ? {} : { "Last-Event-ID": lastId }),
        };
        const response = await serverFetch(`/api/runs/${runId}/log`, { headers, signal: controller.signal });
        if (!response.ok || response.body === null) {
          // Refused, e.g. a herdr run or a run that is gone: trying again changes nothing.
          handlers.onError(await failureMessage(response));
          return;
        }
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const parsed = parseServerSentEvents(buffer + value);
          buffer = parsed.rest;
          for (const event of parsed.events) {
            if (event.id !== undefined) lastId = event.id;
            if (event.event === "log") {
              handlers.onChunk(JSON.parse(event.data) as RunLogChunk);
            } else if (event.event === "error") {
              handlers.onError((JSON.parse(event.data) as { message: string }).message);
            } else if (event.event === "end") {
              handlers.onEnd();
              return;
            }
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn("toodo: run log stream dropped, reconnecting", error);
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  })();
  return () => controller.abort();
}
