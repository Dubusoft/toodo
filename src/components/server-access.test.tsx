import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerAccess } from "@/components/server-access";
import { guessDeviceLabel } from "@/web/devices";
import { getToken } from "@/web/session";

const deviceToken = "d".repeat(64);

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A server whose shared token is "shared" and that knows one device token. */
function fakeServer() {
  return vi.fn(async (path: string, init: RequestInit = {}) => {
    const token = new Headers(init.headers).get("Authorization")?.replace("Bearer ", "");
    if (token !== "shared" && token !== deviceToken) return reply(401, "missing or wrong Toodo access token");
    if (path === "/api/devices" && (init.method ?? "GET") === "GET") {
      return reply(200, [{ id: 1, label: "Phone", createdAt: 1, lastSeenAt: 1, revokedAt: null, current: token === deviceToken }]);
    }
    if (path === "/api/devices" && init.method === "POST") {
      const { label } = JSON.parse(String(init.body)) as { label: string };
      return reply(201, { device: { id: 2, label, createdAt: 2, lastSeenAt: 2, revokedAt: null, current: false }, token: deviceToken });
    }
    return reply(404, "not found");
  });
}

function signIn(token: string, label?: string) {
  render(
    <ServerAccess>
      <p>App</p>
    </ServerAccess>,
  );
  fireEvent.change(screen.getByLabelText("Access token"), { target: { value: token } });
  if (label !== undefined) fireEvent.change(screen.getByLabelText("Device name"), { target: { value: label } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("ServerAccess", () => {
  let server: ReturnType<typeof fakeServer>;

  beforeEach(() => {
    localStorage.clear();
    server = fakeServer();
    vi.stubGlobal("fetch", server);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers this browser as a device with the shared token and keeps the device token", async () => {
    signIn(" shared ", " Work laptop ");

    expect(await screen.findByText("App")).toBeInTheDocument();
    expect(getToken()).toBe(deviceToken);
    const registration = server.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(registration?.[1]?.body))).toEqual({ label: "Work laptop" });
  });

  it("keeps a device token as it is without registering again", async () => {
    signIn(deviceToken);

    expect(await screen.findByText("App")).toBeInTheDocument();
    expect(getToken()).toBe(deviceToken);
    expect(server.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("says when the server rejects the token and keeps nothing", async () => {
    signIn("wrong");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The server did not accept this token.");
    const field = screen.getByLabelText("Access token");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(expect.stringContaining("The server did not accept this token."));
    expect(field).toHaveFocus();
    expect(getToken()).toBeNull();

    fireEvent.change(field, { target: { value: "shared" } });
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("guessDeviceLabel", () => {
  it("names the browser and the system", () => {
    const android =
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";
    const edge =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0";
    expect(guessDeviceLabel(android)).toBe("Chrome on Android");
    expect(guessDeviceLabel(iphone)).toBe("Safari on iOS");
    expect(guessDeviceLabel(edge)).toBe("Edge on Windows");
    expect(guessDeviceLabel("curl/8.5")).toBe("Browser");
  });
});
