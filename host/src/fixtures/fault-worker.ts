import type { HostToWorker, WorkerToHost } from "../protocol.ts";

declare const self: Worker;

export type Fault = "none" | "throw" | "reject" | "loop" | "exit";

/** A stand-in supervisor Worker for the host tests: it beats every 20 ms, then fails the way `fault` says. */
export const runFaultWorker = (fault: Fault): void => {
  const post = (message: WorkerToHost): void => { self.postMessage(message); };
  const beat = setInterval(() => { post({ type: "heartbeat" }); }, 20);
  self.addEventListener("message", (event: MessageEvent<HostToWorker>) => {
    if (event.data.type !== "stop") return;
    clearInterval(beat);
    post({ type: "stopped" });
    process.exit(0);
  });
  post({ type: "ready" });
  setTimeout(() => {
    if (fault === "throw") throw new Error("injected exception");
    if (fault === "reject") void Promise.reject(new Error("injected rejection"));
    if (fault === "exit") process.exit(7);
    if (fault === "loop") for (;;) { /* blocks the Worker's event loop for good */ }
  }, 0);
};
