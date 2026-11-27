import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARKER } from "../src/lane-file-contract.ts";
import { laneOutputDir } from "../src/lane-files.ts";
import { laneOutputFiles } from "../src/lane-toodo.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("a lane's output attaches its real files but not dori's receipt or other dot files", () => {
  const root = mkdtempSync(join(tmpdir(), "lane-toodo-"));
  dirs.push(root);
  const stateDir = join(root, "state"), out = laneOutputDir(stateDir, "ap-1-1");
  mkdirSync(join(out, "shots"), { recursive: true });
  mkdirSync(join(out, ".cache"), { recursive: true });
  writeFileSync(join(out, MARKER), "{}");
  writeFileSync(join(out, ".DS_Store"), "x");
  writeFileSync(join(out, ".cache", "blob"), "x");
  writeFileSync(join(out, "report.md"), "# report");
  writeFileSync(join(out, "shots", "a.png"), "png");
  expect(laneOutputFiles(stateDir, "ap-1-1").map((f) => f.name)).toEqual(["report.md", "a.png"]);
});
