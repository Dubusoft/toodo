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

    sendNotification({ title: "Task started", body: "#1 Add login", pushedAs: "started" });

    expect(shown).toHaveBeenCalledWith("Task started", { body: "#1 Add login" });
  });

  it("shows an alert the server never pushes without asking", () => {
    sendNotification({ title: "Task paused", body: "#1 Add login", pushedAs: null });

    expect(shown).toHaveBeenCalledWith("Task paused", { body: "#1 Add login" });
    expect(pushCovers).not.toHaveBeenCalled();
  });

  it("leaves the alert to the server's push when it pushes that alert", () => {
    vi.mocked(pushCovers).mockReturnValue(true);

    sendNotification({ title: "태스크 시작됨", body: "#1 Add login", pushedAs: "started" });

    expect(shown).not.toHaveBeenCalled();
    expect(pushCovers).toHaveBeenCalledWith("started");
  });
});
