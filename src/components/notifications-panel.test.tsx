import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsPanel } from "@/components/notifications-panel";
import { enablePush, getPushState, pushSupport, saveSettings, sendTest, type PushState } from "@/web/push";

vi.mock("@/web/push", () => ({
  pushSupport: vi.fn(),
  getPushState: vi.fn(),
  enablePush: vi.fn(),
  disablePush: vi.fn(),
  saveSettings: vi.fn(),
  sendTest: vi.fn(),
}));

const settings = { agent: true, pullRequests: true, completion: true };
const subscription = { endpoint: "https://push.example/a", settings };
const off: PushState = { publicKey: "BP8A-_w", permission: "default", subscription: null };
const on: PushState = { ...off, permission: "granted", subscription };

function renderPanel() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NotificationsPanel />
    </QueryClientProvider>,
  );
}

describe("NotificationsPanel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(pushSupport).mockReturnValue("supported");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for permission within the click and then shows the settings", async () => {
    const requestPermission = vi.fn(async (): Promise<NotificationPermission> => "granted");
    vi.stubGlobal("Notification", { requestPermission });
    vi.mocked(getPushState).mockResolvedValue(off);
    vi.mocked(enablePush).mockResolvedValue(subscription);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Enable notifications on this device" }));

    expect(requestPermission).toHaveBeenCalledOnce();
    await waitFor(() => expect(enablePush).toHaveBeenCalledOnce());
    const [permission, publicKey] = vi.mocked(enablePush).mock.calls[0];
    await expect(permission).resolves.toBe("granted");
    expect(publicKey).toBe(off.publicKey);
    expect(await screen.findByRole("checkbox", { name: "Agent finished or needs input" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Disable notifications on this device" })).toBeInTheDocument();
  });

  it("saves a setting as soon as its box changes", async () => {
    vi.mocked(getPushState).mockResolvedValue(on);
    vi.mocked(saveSettings).mockResolvedValue({ ...subscription, settings: { ...settings, pullRequests: false } });
    renderPanel();

    fireEvent.click(await screen.findByRole("checkbox", { name: "Pull request checks and reviews" }));

    await waitFor(() => expect(saveSettings).toHaveBeenCalledOnce());
    expect(vi.mocked(saveSettings).mock.calls[0][0]).toEqual({ agent: true, pullRequests: false, completion: true });
    expect(screen.getByRole("checkbox", { name: "Pull request checks and reviews" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Task awaiting completion" })).toBeChecked();
  });

  it("shows why the server refused to turn notifications on", async () => {
    vi.stubGlobal("Notification", { requestPermission: async () => "granted" });
    vi.mocked(getPushState).mockResolvedValue(off);
    vi.mocked(enablePush).mockRejectedValue(new Error("sign in with a device token to get notifications"));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Enable notifications on this device" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("sign in with a device token");
  });

  it("confirms a test notification the server sent", async () => {
    vi.mocked(getPushState).mockResolvedValue(on);
    vi.mocked(sendTest).mockResolvedValue();
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Send test notification" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Test notification sent.");
  });

  it("points to the browser settings when notifications are blocked", async () => {
    vi.mocked(getPushState).mockResolvedValue({ ...off, permission: "denied" });
    renderPanel();

    expect(await screen.findByText(/blocked for Toodo in the browser settings/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable notifications on this device" })).not.toBeInTheDocument();
  });

  it("asks to add Toodo to the Home Screen where only installed apps get pushes", () => {
    vi.mocked(pushSupport).mockReturnValue("needs-install");
    renderPanel();

    expect(screen.getByText(/Add Toodo to the Home Screen/)).toBeInTheDocument();
    expect(getPushState).not.toHaveBeenCalled();
  });
});
