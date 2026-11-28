import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The private env file `dori setup` writes: dori-supervisor.service loads it with EnvironmentFile, the supervisor Worker of toodo.service reads it itself (loadEnvFile). */
export const envFilePath = (home = homedir()): string => join(home, ".dori", "env");

const ASSIGNMENT = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/gm;

/**
 * Every `KEY=value` entry of env-file text, in file order. Like systemd's EnvironmentFile, a value opened with a quote runs
 * to its closing quote across lines (inside double quotes `\"` and `\\` are escapes); a quote that never closes, like an
 * unquoted value, takes the rest of its line, trimmed.
 */
export const parseEnvFile = (text: string): (readonly [name: string, value: string])[] => {
  const entries: (readonly [string, string])[] = [];
  const re = new RegExp(ASSIGNMENT);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = re.lastIndex;
    const quote = text[start];
    if (quote === '"' || quote === "'") {
      let value = "";
      let i = start + 1;
      for (; i < text.length && text[i] !== quote; i++) {
        if (quote === '"' && text[i] === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) i++;
        value += text[i];
      }
      if (i < text.length) {
        entries.push([m[1] ?? "", value]);
        const eol = text.indexOf("\n", i);
        re.lastIndex = eol < 0 ? text.length : eol;
        continue;
      }
    }
    const eol = text.indexOf("\n", start);
    entries.push([m[1] ?? "", text.slice(start, eol < 0 ? text.length : eol).trim()]);
    re.lastIndex = eol < 0 ? text.length : eol;
  }
  return entries;
};

/**
 * Sets every entry of the env file at `path` in `env`, over the values it had, as EnvironmentFile= does for a unit. The
 * supervisor Worker of toodo.service calls it on its own `process.env`, a copy the host's main thread never sees, so the
 * secrets stay out of the unit's environment and out of the thread that serves HTTP. Returns the names it set; none when
 * the file does not exist. Callers must never print the values.
 */
export const loadEnvFile = (env: Record<string, string | undefined>, path: string): string[] => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const names: string[] = [];
  for (const [name, value] of parseEnvFile(text)) {
    env[name] = value;
    names.push(name);
  }
  return names;
};
