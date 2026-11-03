#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const usage = "Usage: npm run bump <major|minor|patch|X.Y.Z>, or npm run check-version";

const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;

function nextVersion(current, request) {
  const parts = versionPattern.exec(current);
  if (!parts) throw new Error(`Current version ${current} is not X.Y.Z`);
  const [major, minor, patch] = parts.slice(1).map(Number);
  switch (request) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      if (!versionPattern.test(request)) throw new Error(usage);
      return request;
  }
}

// Each file keeps its own formatting (and line endings), so the version is replaced in
// place; `count` is how many occurrences must change, which catches a layout change.
const files = [
  { path: "package.json", pattern: /("version": ")([^"]+)(")/, count: 1 },
  { path: "package-lock.json", pattern: /("version": ")([^"]+)(")/, count: 2 },
  { path: "src-tauri/Cargo.toml", pattern: /^(version = ")([^"]+)(")/m, count: 1 },
  { path: "src-tauri/Cargo.lock", pattern: /(name = "toodo"\r?\nversion = ")([^"]+)(")/, count: 1 },
];

function main() {
  const request = process.argv[2];
  if (!request || process.argv.length > 3) throw new Error(usage);

  const current = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  // --check replaces each version with itself, so it fails exactly where a bump would.
  const check = request === "--check";
  const next = check ? current : nextVersion(current, request);
  if (!check && next === current) throw new Error(`Version is already ${current}`);

  const updates = files.map(({ path, pattern, count }) => {
    let text = readFileSync(join(root, path), "utf8");
    let from = 0;
    for (let i = 0; i < count; i++) {
      const match = pattern.exec(text.slice(from));
      if (!match || match[2] !== current) {
        throw new Error(`${path}: expected version ${current} (occurrence ${i + 1} of ${count})`);
      }
      const start = from + match.index;
      const replacement = match[1] + next + match[3];
      text = text.slice(0, start) + replacement + text.slice(start + match[0].length);
      from = start + replacement.length;
    }
    return { path, text };
  });

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
