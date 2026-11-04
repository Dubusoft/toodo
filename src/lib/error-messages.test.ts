import { describe, expect, it } from "vitest";
import { CommandFailure } from "@/lib/queries";

describe("CommandFailure", () => {
  it("shows the server's message for codes without a message of their own", () => {
    const failure = new CommandFailure({ kind: "rejected", code: "dependencyCycle", message: "dependency cycle: 1 -> 2 -> 1" });

    expect(failure.message).toBe("dependency cycle: 1 -> 2 -> 1");
    expect(failure.code).toBe("dependencyCycle");
  });

  it("asks to reload the page when the server does not know the command", () => {
    const failure = new CommandFailure({ kind: "notFound", code: "unknownCommand", message: "unknown command" });

    expect(failure.message).toMatch(/^This page is out of date with the Toodo server\. Reload the page/);
  });

  it("points to the server log instead of internal details after a panic", () => {
    const failure = new CommandFailure({
      kind: "internal",
      code: "commandPanicked",
      message: "the command stopped unexpectedly on the server",
    });

    expect(failure.message).toContain("toodo-server log");
  });
});
