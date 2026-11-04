import type { CommandError } from "@/lib/bindings";

/**
 * The message the web app shows for a command error, chosen by its code. Codes whose
 * server message is written for agents or the server log get a message with the next
 * step in the app; every other code shows the server's own message.
 */
export function commandErrorMessage(error: CommandError): string {
  switch (error.code) {
    case "unknownCommand":
    case "invalidArguments":
      return "This page is out of date with the Toodo server. Reload the page, then try again.";
    case "commandPanicked":
      return 'Something went wrong on the Toodo server. Try again; if it keeps failing, look for "a command panicked" in the toodo-server log.';
    case "storageFailed":
      return `The Toodo server could not use its database (${error.message}). Try again; if it keeps failing, check the toodo-server log.`;
    default:
      return error.message;
  }
}
