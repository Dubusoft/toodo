import { describe, expect, it } from "vitest";
import { appendSpoken, voiceErrorMessage } from "@/lib/voice";

describe("voice input", () => {
  it("adds what was said to the end of the draft with one space between", () => {
    expect(appendSpoken("", " Ship it ")).toBe("Ship it");
    expect(appendSpoken("Please", "ship it")).toBe("Please ship it");
    expect(appendSpoken("Please ", "ship it")).toBe("Please ship it");
    expect(appendSpoken("Please", "  ")).toBe("Please");
  });

  it("says nothing for a stop the person asked for and tells other failures", () => {
    expect(voiceErrorMessage("aborted")).toBeNull();
    expect(voiceErrorMessage("not-allowed")).toContain("microphone");
    expect(voiceErrorMessage("something-new")).toContain("something-new");
  });
});
