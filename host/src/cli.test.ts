import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openWriter } from "../../server/src/storage/database.ts";
import { createDatabase } from "../../server/src/storage/testing.ts";
import { type Check, type DoctorDeps, hostConfig, ROOT, type Ran, renderUnit, runDoctor, serviceInstall, UNIT } from "./cli.ts";

const TEMPLATE = readFileSync(join(ROOT, "host", UNIT), "utf8");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "toodo-cli-"));
  dirs.push(dir);
  return dir;
};

/** A home with the old units, a dori env file, a data directory with a database and tokens, and the ping file. */
const home = () => {
  const dir = tempDir();
  const units = join(dir, ".config", "systemd", "user");
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, "toodo-server.service"), [
    "[Service]", "ExecStart=/home/a/.local/bin/toodo-server", "Environment=TOODO_LISTEN=127.0.0.1:47616",
    `Environment=TOODO_DATA_DIR=${join(dir, "data")}`, "Environment=TOODO_WEB_DIR=/home/a/.local/share/toodo-server-web",
    "Environment=TOODO_PUBLIC_URL=https://toodo.example.com", "",
  ].join("\n"));
  writeFileSync(join(units, "dori-supervisor.service"), [
    "[Service]", "EnvironmentFile=/home/a/.dori/env", "Environment=DORI_CONFIG=/home/a/.dori/config.json",
    "Environment=PATH=/home/a/.bun/bin:/usr/bin", "Environment=GH_TOKEN=leaked", "",
  ].join("\n"));
  mkdirSync(join(dir, ".dori"));
  writeFileSync(join(dir, ".dori", "env"), "DORI_DISCORD_TOKEN=x\nGH_TOKEN=y\n");
  mkdirSync(join(dir, "data"));
  createDatabase(join(dir, "data", "toodo.sqlite3"));
  openWriter(join(dir, "data", "toodo.sqlite3")).close();
  writeFileSync(join(dir, "data", "web-token"), "web");
  writeFileSync(join(dir, "data", "mcp-token"), "mcp");
  writeFileSync(join(dir, ".config", "host-healthcheck.env"), "HC_TOODO_URL=https://hc-ping.com/a\nHC_DORI_URL=https://hc-ping.com/b\n");
  return { dir, units, env: { HOME: dir, XDG_CONFIG_HOME: join(dir, ".config"), PATH: "/usr/bin" } };
};

describe("service install", () => {
  test("writes the unit for this checkout with the old units' settings, no secret, and reloads systemd", async () => {
    const h = home();
    const calls: string[] = [];
    const run = async (argv: readonly string[]): Promise<Ran> => { calls.push(argv.join(" ")); return { code: 0, out: "" }; };
    expect(await serviceInstall({ env: h.env, run, platform: "linux", bun: "/home/a/.bun/bin/bun", log: () => {} })).toBe(0);
    const unit = readFileSync(join(h.units, UNIT), "utf8");
    expect(unit).toContain(`WorkingDirectory=${ROOT}\n`);
    expect(unit).toContain(`ExecStart=/home/a/.bun/bin/bun ${ROOT}/host/src/main.ts\n`);
    expect(unit).toContain("Environment=TOODO_LISTEN=127.0.0.1:47616\n");
    expect(unit).toContain("Environment=TOODO_PUBLIC_URL=https://toodo.example.com\n");
    expect(unit).toContain(`Environment=TOODO_WEB_DIR=${ROOT}/dist-web\n`);
    expect(unit).toContain("Environment=DORI_CONFIG=/home/a/.dori/config.json\n");
    expect(unit).toContain("Environment=PATH=/home/a/.bun/bin:/usr/bin\n");
    expect(unit).not.toMatch(/^EnvironmentFile=/m);
    expect(unit).not.toContain("GH_TOKEN");
    expect(unit).not.toContain("{{");
    expect(calls).toEqual(["systemctl --user daemon-reload"]);
  });

  test("carries the settings of toodo-server.service's drop-ins, applied in name order after the unit", async () => {
    const h = home();
    const dropIns = join(h.units, "toodo-server.service.d");
    mkdirSync(dropIns);
    writeFileSync(join(dropIns, "cf-access.conf"), "[Service]\nEnvironment=TOODO_CF_ACCESS_TEAM_DOMAIN=team.example.com\nEnvironment=TOODO_CF_ACCESS_AUD=aud\n");
    writeFileSync(join(dropIns, "listen.conf"), "[Service]\nEnvironment=TOODO_LISTEN=127.0.0.1:5000\n");
    writeFileSync(join(dropIns, "npm.conf"), "[Service]\nExecStart=\nExecStart=/npm/toodo-server\nEnvironment=TOODO_WEB_DIR=/npm/web\n");
    writeFileSync(join(dropIns, "notes.txt"), "[Service]\nEnvironment=TOODO_PUBLIC_URL=https://ignored.example.com\n");
    expect(await serviceInstall({ env: h.env, run: async () => ({ code: 0, out: "" }), platform: "linux", bun: "/b", log: () => {} })).toBe(0);
    const unit = readFileSync(join(h.units, UNIT), "utf8");
    expect(unit).toContain("Environment=TOODO_CF_ACCESS_TEAM_DOMAIN=team.example.com\n");
    expect(unit).toContain("Environment=TOODO_CF_ACCESS_AUD=aud\n");
    expect(unit).toContain("Environment=TOODO_LISTEN=127.0.0.1:5000\n");
    expect(unit).toContain("Environment=TOODO_PUBLIC_URL=https://toodo.example.com\n");
    expect(unit).toContain(`Environment=TOODO_WEB_DIR=${ROOT}/dist-web\n`);
    expect(unit).not.toContain("/npm/");
  });

  test("refuses a host without systemd", async () => {
    const h = home();
    expect(await serviceInstall({ env: h.env, run: async () => ({ code: 0, out: "" }), platform: "darwin", bun: "bun", log: () => {} })).toBe(1);
  });

  test("quotes a value with spaces", () => {
    const unit = renderUnit(TEMPLATE, { src: "/s", bun: "/b", path: "/p", server: "Environment=\"TOODO_CHAT_AGENT_NAME=Dori Bot\"\n", supervisor: "" });
    expect(unit).toContain('Environment="TOODO_CHAT_AGENT_NAME=Dori Bot"\n');
  });
});

describe("hostConfig", () => {
  test("takes the data directory from the option, else the environment, else the unit, else toodo init's record", () => {
    const h = home();
    writeFileSync(join(h.units, UNIT), "[Service]\nEnvironment=TOODO_DATA_DIR=/from/unit\nEnvironment=TOODO_LISTEN=127.0.0.1:5000\n");
    expect(hostConfig(h.env, "/from/option").dataDir).toBe("/from/option");
    expect(hostConfig({ ...h.env, TOODO_DATA_DIR: "/from/env" }, undefined).dataDir).toBe("/from/env");
    expect(hostConfig(h.env, undefined)).toMatchObject({ dataDir: "/from/unit", listen: { hostname: "127.0.0.1", port: 5000 } });
    rmSync(join(h.units, UNIT));
    mkdirSync(join(h.dir, ".config", "toodo"));
    writeFileSync(join(h.dir, ".config", "toodo", "data-dir"), "/recorded\n");
    expect(hostConfig(h.env, undefined).dataDir).toBe("/recorded");
  });
});

describe("toodo review", () => {
  test("prints the report from the database with the TypeScript storage", async () => {
    const h = home();
    const child = Bun.spawn([process.execPath, join(ROOT, "host", "src", "cli.ts"), "review", "--period", "year", "--date", "2026-03-01", "--format", "csv", "--data-dir", join(h.dir, "data")], {
      env: { ...process.env, HOME: h.env.HOME, XDG_CONFIG_HOME: h.env.XDG_CONFIG_HOME }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(out.split("\n")[0]).toContain("Outcome");
  });
});

describe("toodo doctor", () => {
  const deps = (h: ReturnType<typeof home>, states: Record<string, string>, show: Record<string, string>): DoctorDeps => ({
    env: h.env,
    config: hostConfig(h.env, join(h.dir, "data")),
    run: async (argv) => {
      const key = argv.slice(2).join(" ");
      if (argv[2] === "is-active") return { code: states[argv[3]!] === "active" ? 0 : 3, out: states[argv[3]!] ?? "inactive" };
      return { code: 0, out: show[key] ?? "" };
    },
    fetch: async (input) => input.endsWith("/api/host")
      ? Response.json({ supervisor: { state: "running" } })
      : Response.json({ name: "toodo", version: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version }),
  });
  const levels = (checks: readonly Check[]) => Object.fromEntries(checks.map((c) => [c.name, c.level]));

  test("passes a host that runs toodo.service from this checkout with no secret in its environment", async () => {
    const h = home();
    writeFileSync(join(h.units, UNIT), "[Service]\n");
    const checks = await runDoctor(deps(h, { [UNIT]: "active" }, {
      [`show ${UNIT} --property=WorkingDirectory --value`]: ROOT,
      [`show ${UNIT} --property=Environment --value`]: "TOODO_LISTEN=127.0.0.1:47616 PATH=/usr/bin",
    }));
    expect(checks.filter((c) => c.level !== "OK")).toEqual([]);
    expect(levels(checks)).toMatchObject({ [`unit ${UNIT}`]: "OK", "unit secrets": "OK", supervisor: "OK", "server version": "OK", database: "OK", healthcheck: "OK" });
  });

  test("fails another checkout, a dori secret in the unit, and an old unit running beside it", async () => {
    const h = home();
    writeFileSync(join(h.units, UNIT), "[Service]\n");
    const checks = await runDoctor(deps(h, { [UNIT]: "active", "dori-supervisor.service": "active" }, {
      [`show ${UNIT} --property=WorkingDirectory --value`]: "/home/a/old-deploy",
      [`show ${UNIT} --property=Environment --value`]: "GH_TOKEN=y PATH=/usr/bin",
    }));
    expect(levels(checks)).toMatchObject({ "unit checkout": "FAIL", "unit secrets": "FAIL", "unit dori-supervisor.service": "FAIL" });
  });
});
