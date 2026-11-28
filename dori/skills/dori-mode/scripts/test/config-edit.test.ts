import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { doriConfigStore } from "../src/config-edit.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const SECRET_ARGV = ["/opt/deploy-7f3e/run.sh", "--target=prod-db-91"];

const fixture = (file: Record<string, unknown> | string | null = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "config-edit-test-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  const base = {
    schemaVersion: 10, stateDir: join(dir, "state"), leadCwd: dir, defaultModel: "a/b", ownerLanguage: "Korean",
    secretCommands: { deploy: { argv: SECRET_ARGV, secrets: ["DEPLOY_TOKEN_7F3E"] } }, agentCommand: ["omo", "{prompt}"],
  };
  if (file !== null) writeFileSync(path, typeof file === "string" ? file : `${JSON.stringify({ ...base, ...file }, null, 2)}\n`, { mode: 0o600 });
  return { dir, path, store: doriConfigStore(path), text: () => readFileSync(path, "utf8"), backups: () => readdirSync(dir).filter((f) => f.endsWith(".bak")) };
};

const entry = (f: ReturnType<typeof fixture>, key: string) => f.store.view().entries.find((e) => e.key === key);

test("the view lists every key with its value as text, host command keys read-only and secret operations by name alone", () => {
  const f = fixture({ ignorePanes: ["1", "2"], autopilot: { tickSec: 60 } });
  const view = f.store.view();
  expect(view).toMatchObject({ path: f.path, present: true, error: null });
  expect(entry(f, "ownerLanguage")).toMatchObject({ value: "Korean", access: "edit", kind: "string", restart: false });
  expect(entry(f, "ignorePanes")?.value).toBe("1,2");
  expect(entry(f, "autopilot")?.value).toBe('{"tickSec":60}');
  expect(entry(f, "stateDir")).toMatchObject({ access: "readOnly", restart: true });
  expect(entry(f, "agentCommand")).toMatchObject({ access: "readOnly", value: "omo,{prompt}" });
  expect(entry(f, "secretCommands")).toMatchObject({ access: "masked", value: "deploy" });
  const body = JSON.stringify(view);
  for (const hidden of [...SECRET_ARGV, "DEPLOY_TOKEN_7F3E"]) expect(body).not.toContain(hidden);
});

test("a value shaped like a credential is masked whatever key holds it", () => {
  const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
  const f = fixture({ leadThinking: token });
  expect(entry(f, "leadThinking")?.access).toBe("masked");
  expect(JSON.stringify(f.store.view())).not.toContain(token);
});

test("a valid save writes the file with a 0600 backup of the one it replaced, and an empty value unsets the key", async () => {
  const f = fixture();
  const before = f.text();
  const saved = await f.store.save({ key: "ownerLanguage", value: "Japanese" });
  expect(saved).toMatchObject({ restart: false });
  expect(JSON.parse(f.text())).toMatchObject({ ownerLanguage: "Japanese", schemaVersion: 10, secretCommands: { deploy: { argv: SECRET_ARGV } } });
  expect(statSync(f.path).mode & 0o777).toBe(0o600);
  const [backup] = f.backups();
  expect(readFileSync(join(f.dir, backup!), "utf8")).toBe(before);
  expect(statSync(join(f.dir, backup!)).mode & 0o777).toBe(0o600);
  await f.store.save({ key: "ignorePanes", value: "10, 20" });
  expect(JSON.parse(f.text()).ignorePanes).toEqual(["10", "20"]);
  await f.store.save({ key: "ownerLanguage", value: " " });
  expect("ownerLanguage" in JSON.parse(f.text())).toBe(false);
});

test("an invalid save is refused with the reason and leaves the file and its backups alone", async () => {
  const f = fixture();
  const before = f.text();
  const refusals: [string, string, number, string][] = [
    ["autopilot", "{not json", 400, "autopilot must be JSON"],
    ["autoReport", "sometimes", 400, "autoReport must be one of"],
    ["displayTimeZone", "Mars/Olympus", 400, "displayTimeZone must be an IANA time zone"],
    ["defaultModel", "", 400, "defaultModel is required"],
    ["agentCommand", "sh,-c,id", 403, "changed only on the host"],
    ["secretCommands", "{}", 403, "changed only on the host"],
    ["nope", "1", 400, "nope is not a dori config key"],
  ];
  for (const [key, value, status, message] of refusals) {
    const result = await f.store.save({ key, value });
    expect(result).toMatchObject({ status });
    expect("message" in result ? result.message : "").toContain(message);
  }
  expect(f.text()).toBe(before);
  expect(f.backups()).toEqual([]);
});

test("without a readable file nothing is saved", async () => {
  const missing = fixture(null);
  expect(missing.store.view()).toMatchObject({ present: false, error: null });
  expect(await missing.store.save({ key: "ownerLanguage", value: "English" })).toMatchObject({ status: 409 });
  const broken = fixture("{");
  expect(broken.store.view().error).toContain("is not valid JSON");
  expect(await broken.store.save({ key: "ownerLanguage", value: "English" })).toMatchObject({ status: 409 });
  expect(broken.text()).toBe("{");
});
