import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// The main thread serves the core's HTTP, so a blocking call there stalls every request. This walks the static
// imports from the host's entry (the Worker entry is loaded by URL, not imported, so it stays out) and fails on any
// `*Sync(` call in that graph, Bun.spawnSync included.
const ENTRY = resolve(import.meta.dir, "main.ts");

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
      if (path.startsWith(".")) await visit(resolve(dirname(file), path));
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
