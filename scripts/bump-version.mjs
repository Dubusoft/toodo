#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nextVersion, replaceVersion, usage } from "./version.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Each file keeps its own formatting (and line endings), so the version is replaced in
// place; `count` is how many occurrences must change, which catches a layout change.
const files = [
  { path: "package.json", pattern: /("version": ")([^"]+)(")/, count: 1 },
  { path: "package-lock.json", pattern: /("version": ")([^"]+)(")/, count: 2 },
];

function main() {
  const request = process.argv[2];
  if (!request || process.argv.length > 3) throw new Error(usage);

  const current = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  // --check replaces each version with itself, so it fails exactly where a bump would.
  const check = request === "--check";
  const next = check ? current : nextVersion(current, request);
  if (!check && next === current) throw new Error(`Version is already ${current}`);

  const updates = files.map((file) => ({
    path: file.path,
    text: replaceVersion(readFileSync(join(root, file.path), "utf8"), file, current, next),
  }));

  if (check) {
    console.log(`Version ${current} is the same in all ${files.length} version files.`);
    return;
  }
  for (const { path, text } of updates) writeFileSync(join(root, path), text);
  console.log(`Bumped version ${current} -> ${next}. Commit as "Release ${next}".`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
