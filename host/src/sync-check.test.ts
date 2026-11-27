import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// The main thread serves the core's HTTP, so a blocking call there stalls every request. This walks the static
// imports of the host's own code from its entry and fails on any `*Sync(` call in that graph, Bun.spawnSync included.
// The Worker entry is loaded by URL, not imported, so it stays out. So does the core (server/): it is the work this
// thread exists for, and its storage is bun:sqlite, which only has synchronous calls; the host's job is to add no
// blocking of its own around it.
const ENTRY = resolve(import.meta.dir, "main.ts");
const HOST_DIR = resolve(import.meta.dir, "..");

const transpiler = new Bun.Transpiler({ loader: "ts" });

const syncCalls = async (entry: string): Promise<string[]> => {
  const seen = new Set<string>();
  const found: string[] = [];
  const visit = async (file: string): Promise<void> => {
    if (seen.has(file)) return;
    seen.add(file);
    // Transpiling drops comments and types, so only code is searched.
    const code = transpiler.transformSync(await readFile(file, "utf8"));
    for (const match of code.matchAll(/\b([A-Za-z_$][\w$]*Sync)\s*\(/g)) found.push(`${file}: ${match[1]}()`);
    for (const { path } of transpiler.scan(code).imports) {
      const target = resolve(dirname(file), path);
      if (path.startsWith(".") && target.startsWith(`${HOST_DIR}/`)) await visit(target);
    }
  };
  await visit(entry);
  return found;
};

describe("main thread", () => {
  test("makes no *Sync calls", async () => {
    expect(await syncCalls(ENTRY)).toEqual([]);
  });
});
