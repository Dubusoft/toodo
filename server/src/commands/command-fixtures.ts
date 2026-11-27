import { CommandError } from "./errors.ts";

/** The `CommandError` `run` throws; anything else fails the test. */
export function commandFailure(run: () => unknown): CommandError {
  try {
    run();
  } catch (error) {
    if (error instanceof CommandError) return error;
    throw error;
  }
  throw new Error("Expected a command error");
}
