import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendNotification } from "@/web/notification";
import { pushCovers } from "@/web/push";

vi.mock("@/web/push", () => ({ pushCovers: vi.fn() }));

describe("sendNotification", () => {
  const shown = vi.fn();

  beforeEach(() => {
    shown.mockReset();
    vi.stubGlobal(
      "Notification",
      class {
        constructor(title: string, options?: NotificationOptions) {
          shown(title, options);
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the alert while the server does not push it to this device", () => {
    vi.mocked(pushCovers).mockReturnValue(false);

    sendNotification({ title: "Agent finished", body: "#1 Add login" });

    expect(shown).toHaveBeenCalledWith("Agent finished", { body: "#1 Add login" });
  });

  it("leaves the alert to the server's push when it pushes that alert", () => {
    vi.mocked(pushCovers).mockReturnValue(true);

    sendNotification({ title: "Agent finished", body: "#1 Add login" });

    expect(shown).not.toHaveBeenCalled();
    expect(pushCovers).toHaveBeenCalledWith("Agent finished");
  });
});
