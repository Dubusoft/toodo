import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile, parseEnvFile } from "../src/credentials.ts";
import { withState } from "./fakes.ts";

const SECRET = "file-secret-value";
const homeWithEnv = (dir: string, text: string): void => {
  mkdirSync(join(dir, ".dori"), { recursive: true });
  writeFileSync(join(dir, ".dori", "env"), text);
};

test("parseEnvFile keeps a quoted value whole across lines and reads every entry after it", () => {
  const text = 'A=1\r\nKEY="line one\nline \\"two\\""\nexport B=\'x\ny\' # note\nC="open\n';
  expect(parseEnvFile(text)).toEqual([["A", "1"], ["KEY", 'line one\nline "two"'], ["B", "x\ny"], ["C", '"open']]);
});

test("loadEnvFile sets every entry over the inherited value and sets nothing without a file", () => {
  const state = withState();
  try {
    homeWithEnv(state.dir, `DORI_EXAMPLE_TOKEN=${SECRET}\nexport GH_TOKEN="gh value"\n`);
    const env: Record<string, string | undefined> = { DORI_EXAMPLE_TOKEN: "inherited", PATH: "/bin" };
    expect(loadEnvFile(env, join(state.dir, ".dori", "env"))).toEqual(["DORI_EXAMPLE_TOKEN", "GH_TOKEN"]);
    expect(env).toEqual({ DORI_EXAMPLE_TOKEN: SECRET, GH_TOKEN: "gh value", PATH: "/bin" });
    const untouched: Record<string, string | undefined> = { PATH: "/bin" };
    expect(loadEnvFile(untouched, join(state.dir, "missing"))).toEqual([]);
    expect(untouched).toEqual({ PATH: "/bin" });
  } finally { state.done(); }
});
