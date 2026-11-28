import type { CommandError } from "@/lib/bindings";
import { en, type Messages } from "@/locales/en";

/** Keeps the diagnostic message stable while letting the UI format an error at render time. */
export class LocalizedError extends Error {
  constructor(readonly localize: (m: Messages) => string) {
    super(localize(en));
  }
}

/**
 * The message the web app shows for `error`. An error the app itself ran into, such as a
 * `TypeError` from a reply it could not read, shows a message from the catalog instead of
 * its text, which is written for developers.
 */
export function errorMessage(error: Error, m: Messages): string {
  if (error instanceof LocalizedError) return error.localize(m);
  return isProgramError(error) ? m.app.unexpectedError : error.message;
}

function isProgramError(error: Error): boolean {
  return error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError || error instanceof SyntaxError;
}

/**
 * The message the web app shows for a command error, chosen by its code. Codes whose
 * server message is written for agents or the server log get a message with the next
 * step in the app; every other code shows the server's own message.
 */
export function commandErrorMessage(error: CommandError, m: Messages): string {
  const copy = m.app.commandError;
  switch (error.code) {
    case "unknownCommand":
    case "invalidArguments":
      return copy.outOfDate;
    case "commandPanicked":
      return copy.panicked;
    case "guidelineNotFound":
      return copy.guidelineMissing;
    case "storageFailed":
      return copy.storageFailed(error.message);
    case "notFound":
    case "workspaceNotFound":
    case "taskNotFound":
    case "criterionNotFound":
    case "dependencyNotFound":
    case "relationNotFound":
    case "runNotFound":
    case "chatMessageNotFound":
    case "chatChannelNotFound":
    case "chatThreadNotFound":
      return copy.notFound;
    case "dependencyCycle":
      return copy.dependencyCycle;
    case "dependenciesNotDone":
      return copy.dependenciesNotDone;
    case "invalidTransition":
      return copy.invalidTransition;
    case "notPermitted":
      return copy.notPermitted;
    default:
      return error.message;
  }
}
