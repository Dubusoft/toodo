// How a command fails: a `CommandError` with a stable code, the kind the code belongs to,
// and a message. The RPC endpoint and the MCP tools return the same codes, so callers react
// to a code instead of the message text.

import { SQLiteError } from "bun:sqlite";
import { constants } from "node:os";
import type {
  CommandError as CommandErrorBody,
  CommandErrorCode,
  CommandErrorKind,
} from "../../../src/lib/api.ts";
import { StorageError, type StorageFailure } from "../storage/errors.ts";

export type { CommandErrorCode, CommandErrorKind };

export function codeKind(code: CommandErrorCode): CommandErrorKind {
  switch (code) {
    case "invalidInput":
    case "invalidArguments":
      return "invalidInput";
    case "notFound":
    case "unknownCommand":
    case "workspaceNotFound":
    case "taskNotFound":
    case "criterionNotFound":
    case "dependencyNotFound":
    case "relationNotFound":
    case "runNotFound":
    case "guidelineNotFound":
    case "chatMessageNotFound":
    case "chatChannelNotFound":
    case "chatThreadNotFound":
      return "notFound";
    case "rejected":
    case "dependencyCycle":
    case "invalidTransition":
    case "dependenciesNotDone":
    case "notPermitted":
      return "rejected";
    case "external":
      return "external";
    case "internal":
    case "storageFailed":
    case "commandPanicked":
      return "internal";
  }
}

export class CommandError extends Error {
  readonly kind: CommandErrorKind;
  readonly code: CommandErrorCode;

  constructor(code: CommandErrorCode, message: string) {
    super(message);
    this.name = "CommandError";
    this.kind = codeKind(code);
    this.code = code;
  }

  /** The body the RPC endpoint answers with. */
  toJSON(): CommandErrorBody {
    return { kind: this.kind, code: this.code, message: this.message };
  }
}

export function invalidInput(message: string): CommandError {
  return new CommandError("invalidInput", message);
}

export function notFound(message: string): CommandError {
  return new CommandError("notFound", message);
}

export function rejected(message: string): CommandError {
  return new CommandError("rejected", message);
}

export function internal(message: string): CommandError {
  return new CommandError("internal", message);
}

/** A command that failed unexpectedly. The cause stays in the server log: it describes the
 * server's internals, not what the caller can do about it. */
export function panicked(cause: unknown): CommandError {
  console.error(`toodo-server: a command panicked: ${String(cause)}`);
  return new CommandError(
    "commandPanicked",
    "the command stopped unexpectedly on the server; retry it, and if it fails again, look for \"a command panicked\" in the toodo-server log",
  );
}

function storageCode(failure: StorageFailure): CommandErrorCode {
  switch (failure.kind) {
    case "workspace_not_found":
      return "workspaceNotFound";
    case "task_not_found":
      return "taskNotFound";
    case "dependency":
      return failure.error.problem.kind === "unknown_task" ? "taskNotFound" : "dependencyCycle";
    case "criterion_not_found":
      return "criterionNotFound";
    case "dependency_not_found":
      return "dependencyNotFound";
    case "relation_not_found":
      return "relationNotFound";
    case "guideline_not_found":
      return "guidelineNotFound";
    case "chat_message_not_found":
      return "chatMessageNotFound";
    case "chat_channel_not_found":
      return "chatChannelNotFound";
    case "chat_thread_not_found":
      return "chatThreadNotFound";
    case "device_not_found":
    case "push_subscription_not_found":
    case "chat_action_not_found":
    case "chat_attachment_not_found":
      return "notFound";
    case "transition":
      return "invalidTransition";
    case "dependencies_not_done":
      return "dependenciesNotDone";
    case "workspace_has_dependents":
    case "task_not_archived":
    case "workspace_not_archived":
    case "workspace_archived":
    case "restore_closes_cycle":
    case "prerequisite_of_done_task":
    case "dependency_of_done_task":
    case "criteria_of_done_task":
    case "automatic_criterion":
    case "not_a_persons_message":
    case "not_an_agents_message":
    case "chat_channel_name_taken":
    case "chat_channel_permanent":
    case "chat_thread_not_open":
    case "chat_thread_task_taken":
    case "chat_action_chosen":
    case "chat_attachment_not_free":
      return "rejected";
    case "self_relation":
    case "plan_link_out_of_range":
    case "invalid_backup":
      return "invalidInput";
    case "invalid_data":
    case "backup_check_failed":
      return "storageFailed";
  }
}

/** A failed file operation, as Node reports it. */
interface SystemError extends Error {
  code: string;
  errno: number;
}

function isSystemError(error: unknown): error is SystemError {
  return (
    error instanceof Error &&
    !(error instanceof SQLiteError) &&
    typeof (error as Partial<SystemError>).code === "string" &&
    typeof (error as Partial<SystemError>).errno === "number"
  );
}

/** The C library's description of the errors whose libuv description differs from it. */
const STRERROR: Readonly<Record<string, string>> = {
  EEXIST: "File exists",
  EISDIR: "Is a directory",
};

/**
 * A failed file operation as Rust's `std::io::Error` prints it, e.g. `Not a directory (os
 * error 20)`, so messages that quote one read as the Rust server's. Anything else is printed
 * as it is.
 */
export function ioMessage(error: unknown): string {
  if (!isSystemError(error)) return String(error instanceof Error ? error.message : error);
  const described = /^[A-Z0-9_]+: ([^,]*)/.exec(error.message)?.[1] ?? error.message;
  const text = STRERROR[error.code] ?? described.charAt(0).toUpperCase() + described.slice(1);
  const errno = (constants.errno as Record<string, number | undefined>)[error.code] ?? Math.abs(error.errno);
  return `${text} (os error ${errno})`;
}

/** What a storage operation that threw `error` reports, as Rust's `StorageError` prints it:
 * a file error as `file error: ...`. */
export function storageMessage(error: unknown): string {
  if (isSystemError(error)) return `file error: ${ioMessage(error)}`;
  if (error instanceof SQLiteError) return `database error: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** What a command reports for `error`, thrown while it ran: a `CommandError` as it is, a
 * storage failure under its code with the storage message, a failed file operation as
 * `external`, and a database error as `storageFailed`. Anything else is a bug and is thrown
 * again. */
export function commandError(error: unknown): CommandError {
  if (error instanceof CommandError) return error;
  if (error instanceof StorageError) return new CommandError(storageCode(error.failure), error.message);
  if (isSystemError(error)) return new CommandError("external", storageMessage(error));
  if (error instanceof SQLiteError) return new CommandError("storageFailed", storageMessage(error));
  throw error;
}

/** `run` as a command that waits, such as on a URL check: whatever it throws or rejects
 * with reaches the caller as a `CommandError`. */
export function asyncCommand<Args extends unknown[], Result>(
  run: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    try {
      return await run(...args);
    } catch (error) {
      throw commandError(error);
    }
  };
}

/** `run` as a command: whatever it throws reaches the caller as a `CommandError`. */
export function command<Args extends unknown[], Result>(
  run: (...args: Args) => Result,
): (...args: Args) => Result {
  return (...args) => {
    try {
      return run(...args);
    } catch (error) {
      throw commandError(error);
    }
  };
}
