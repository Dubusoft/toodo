import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DependencyError } from "../domain/dag.ts";
import { guidelineId, taskId } from "../domain/model.ts";
import { TransitionError } from "../domain/status.ts";
import { StorageError, type StorageFailure } from "../storage/errors.ts";
import { commandError, panicked, type CommandErrorCode, type CommandErrorKind } from "./errors.ts";

test("Storage errors map to error codes", () => {
  const cases: [StorageFailure, CommandErrorKind, CommandErrorCode][] = [
    [{ kind: "task_not_found", task: 1 }, "notFound", "taskNotFound"],
    [{ kind: "dependency", error: new DependencyError({ kind: "unknown_task", id: taskId(1) }) }, "notFound", "taskNotFound"],
    [{ kind: "dependency", error: new DependencyError({ kind: "cycle", path: [taskId(1), taskId(1)] }) }, "rejected", "dependencyCycle"],
    [{ kind: "transition", error: new TransitionError("done", "in_progress") }, "rejected", "invalidTransition"],
    [{ kind: "guideline_not_found", guideline: guidelineId(1) }, "notFound", "guidelineNotFound"],
    [{ kind: "invalid_data", reason: "bad" }, "internal", "storageFailed"],
  ];
  for (const [failure, kind, code] of cases) {
    const error = new StorageError(failure);
    expect(commandError(error).toJSON()).toEqual({ kind, code, message: error.message });
  }
});

test("File errors read as Rust prints them and database errors stay storage failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "toodo-command-errors-"));
  try {
    const file = join(dir, "a-file");
    writeFileSync(file, "");
    let fileError: unknown;
    try {
      writeFileSync(join(file, "below"), "");
    } catch (error) {
      fileError = error;
    }
    expect(commandError(fileError).toJSON()).toEqual({
      kind: "external",
      code: "external",
      message: expect.stringMatching(/^file error: Not a directory \(os error \d+\)$/),
    });
    let databaseError: unknown;
    try {
      new Database(":memory:").run("SELECT * FROM missing");
    } catch (error) {
      databaseError = error;
    }
    expect(commandError(databaseError).toJSON()).toEqual({
      kind: "internal",
      code: "storageFailed",
      message: "database error: no such table: missing",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A panic does not reach the caller", () => {
  const error = panicked("index out of bounds: the len is 0");
  expect(error.code).toBe("commandPanicked");
  expect(error.kind).toBe("internal");
  expect(error.message).not.toContain("index out of bounds");
});

test("An error that is no command or storage failure is thrown again", () => {
  const bug = new TypeError("undefined is not a function");
  expect(() => commandError(bug)).toThrow(bug);
});
