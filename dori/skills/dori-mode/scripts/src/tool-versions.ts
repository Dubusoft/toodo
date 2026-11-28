// The versions of the tools a Dori host needs (hc, omo), as Settings > Machines & accounts shows them: read on the
// supervisor host by the supervisor and on a worker by its runner (`q.machine.observe` with `tools`).
import type { Runner } from "./run.ts";
import { hcVersion } from "./runtime/hc.ts";

export type ToolVersions = { readonly hc: string | null; readonly omo: string | null };

/** omo's version (`omo 5.1.84 (engine: ...)` -> 5.1.84), or undefined when omo is not on the PATH or fails. */
export const omoVersion = async (run: Runner): Promise<string | undefined> => {
  const r = await run(["omo", "--version"]).catch(() => undefined);
  return r?.code === 0 ? /^omo (\S+)/.exec(r.out.trim())?.[1] : undefined;
};

export const toolVersions = async (run: Runner): Promise<ToolVersions> => {
  const [hc, omo] = await Promise.all([hcVersion(run), omoVersion(run)]);
  return { hc: hc ?? null, omo: omo ?? null };
};
