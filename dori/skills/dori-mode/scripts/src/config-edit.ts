// config.json as the Toodo Settings page shows and edits it (src/lib/dori-config.ts): the keys `dori setup` manages,
// in the forms it parses, saved only after the checks the supervisor's reload makes, with the backup `dori setup`
// keeps. The host loads this module by URL and serves it on `/api/dori/config`; the supervisor's config watch applies
// a saved change itself.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DoriConfigAccess, DoriConfigEntry, DoriConfigStore, DoriConfigView } from "../../../../../src/lib/dori-config.ts";
import { configPath, loadConfig } from "./config.ts";
import { ConfigKeyError, DORI_CONFIG_KEYS, formatValue, isRequired, type Json, type KeySpec, parseValue } from "./config-keys.ts";
import { configReloadError, RESTART_CONFIG_KEYS } from "./config-watch.ts";
import { redactSecrets } from "./redact.ts";
import { readConfigObject, saveConfig } from "./setup.ts";

/**
 * Keys only the host changes: commands the host runs (a web session must not become a way to run one), where dori
 * keeps its state, and the machines it reaches over ssh.
 */
export const HOST_ONLY_KEYS: ReadonlySet<string> = new Set([
  "stateDir", "agentCommand", "leadArgs", "laneSandbox", "guardMachines", "runners", "hooks", "buttonHooks", "secretCommands",
]);

/** Keys shown by their entry names alone: each secret operation names the secrets it gets. */
export const MASKED_KEYS: ReadonlySet<string> = new Set(["secretCommands"]);

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const entry = (spec: KeySpec, raw: Json): DoriConfigEntry => {
  const current = raw[spec.key];
  let access: DoriConfigAccess = MASKED_KEYS.has(spec.key) ? "masked" : HOST_ONLY_KEYS.has(spec.key) ? "readOnly" : "edit";
  let value = access === "masked" ? (isRecord(current) ? Object.keys(current).join(", ") : "") : formatValue(spec, current);
  // A value that looks like a credential is never shown, whatever key holds it.
  const redacted = redactSecrets(value);
  if (redacted !== value) {
    value = redacted;
    access = "masked";
  }
  return {
    key: spec.key, kind: spec.kind, describe: spec.describe, values: spec.values ?? null, required: isRequired(spec, raw),
    value, access, restart: RESTART_CONFIG_KEYS.includes(spec.key),
  };
};

/** Why the supervisor would refuse `next` as config.json (what its reload checks), or undefined when it takes it. */
const refusal = async (next: Json): Promise<string | undefined> => {
  const dir = mkdtempSync(join(tmpdir(), "dori-config-edit-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(next), { mode: 0o600 });
    return configReloadError(await loadConfig(path));
  } catch (e) {
    return errorText(e);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const doriConfigStore = (path = configPath()): DoriConfigStore => {
  const view = (): DoriConfigView => {
    let raw: Json = {};
    let error: string | null = null;
    try { raw = readConfigObject(path); } catch (e) { error = errorText(e); }
    return { path, present: existsSync(path), error, entries: DORI_CONFIG_KEYS.map((spec) => entry(spec, raw)) };
  };
  return {
    view,
    save: async (edit) => {
      const spec = DORI_CONFIG_KEYS.find((s) => s.key === edit.key);
      if (!spec) return { status: 400, message: `${edit.key} is not a dori config key` };
      if (HOST_ONLY_KEYS.has(spec.key)) return { status: 403, message: `${spec.key} is changed only on the host, in ${path}` };
      if (!existsSync(path)) return { status: 409, message: `${path} does not exist; run dori setup on the host first` };
      let raw: Json;
      try { raw = readConfigObject(path); } catch (e) { return { status: 409, message: errorText(e) }; }
      const next: Json = { ...raw };
      if (edit.value.trim() === "") {
        if (isRequired(spec, raw)) return { status: 400, message: `${spec.key} is required` };
        delete next[spec.key];
      } else {
        try { next[spec.key] = parseValue(spec, edit.value); } catch (e) {
          if (!(e instanceof ConfigKeyError)) throw e;
          return { status: 400, message: e.message };
        }
      }
      const refused = await refusal(next);
      if (refused !== undefined) return { status: 400, message: refused };
      saveConfig(path, raw, next);
      return { view: view(), restart: RESTART_CONFIG_KEYS.includes(spec.key) };
    },
  };
};
