import { afterEach, describe, expect, it } from "vitest";
import { appendSpoken, recognitionErrorMessage, voiceErrorMessage } from "@/lib/voice";

function devices(...kinds: MediaDeviceKind[]) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { enumerateDevices: async () => kinds.map((kind) => ({ kind, deviceId: "", groupId: "", label: "" })) },
  });
}

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

  describe("a refused microphone", () => {
    afterEach(() => {
      Reflect.deleteProperty(navigator, "mediaDevices");
    });

    it("is a missing one where the device has no audio input", async () => {
      devices("audiooutput");
      expect(await recognitionErrorMessage("not-allowed")).toBe(voiceErrorMessage("audio-capture"));
    });

    it("is a blocked one where the device has a microphone or cannot list its devices", async () => {
      devices("audioinput", "audiooutput");
      expect(await recognitionErrorMessage("not-allowed")).toBe(voiceErrorMessage("not-allowed"));
      Reflect.deleteProperty(navigator, "mediaDevices");
      expect(await recognitionErrorMessage("not-allowed")).toBe(voiceErrorMessage("not-allowed"));
    });
  });
});
