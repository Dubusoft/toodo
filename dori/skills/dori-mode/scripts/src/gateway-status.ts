import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { replaceFileAtomic } from "./durable-write.ts";

/**
 * The supervisor's heartbeat file, written every inbound pass: doctor, status and the host's healthcheck read it, so
 * they never touch the lock or the socket. The name predates the removal of the Discord gateway; files of older
 * builds carry two more fields, which are ignored.
 */
export type GatewayStatus = {
  readonly pid: number;
  readonly at: number;
};

export const GATEWAY_STALE_MS = 60_000;

export const gatewayStatusPath = (stateDir: string): string => join(stateDir, "gateway-status.json");

export const writeGatewayStatus = (stateDir: string, status: GatewayStatus): void => {
  mkdirSync(stateDir, { recursive: true });
  const path = gatewayStatusPath(stateDir);
  replaceFileAtomic(path, JSON.stringify(status), 0o600);
};

export const readGatewayStatus = (stateDir: string): GatewayStatus | undefined => {
  try {
    const raw: unknown = JSON.parse(readFileSync(gatewayStatusPath(stateDir), "utf8"));
    if (typeof raw !== "object" || raw === null) return;
    const s = raw as Record<string, unknown>;
    if (typeof s.pid !== "number" || typeof s.at !== "number") return;
    return { pid: s.pid, at: s.at };
  } catch {
    return;
  }
};

export type GatewayView = { readonly state: "live" | "stale" | "missing"; readonly text: string };

/** A fresh heartbeat is "live"; a stale or missing one means the supervisor stopped. */
export const gatewayView = (status: GatewayStatus | undefined, now: number): GatewayView => {
  if (!status) return { state: "missing", text: "no heartbeat file (supervisor not running, or an older build)" };
  const age = Math.max(0, Math.round((now - status.at) / 1000));
  if (now - status.at > GATEWAY_STALE_MS) return { state: "stale", text: `stale: last heartbeat ${age}s ago` };
  return { state: "live", text: `supervisor heartbeat ${age}s ago` };
};
