import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("ConnectionGate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("warns while the server is unreachable, pauses data changes, and clears once it answers", async () => {
    vi.resetModules();
    const { serverFetch } = await import("@/web/connection");
    const { Button } = await import("@/components/ui/button");
    const { ConnectionGate } = await import("@/components/offline-screen");
    let up = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (!up) throw new TypeError("Failed to fetch");
        return new Response(null, { status: 401 });
      }),
    );
    render(
      <ConnectionGate>
        <input aria-label="Draft" defaultValue="typed before the outage" />
        <Button changesData>Save</Button>
        <Button>Look</Button>
      </ConnectionGate>,
    );

    await act(async () => {
      await serverFetch("/api/rpc/list_tasks").catch(() => {});
    });

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Can't reach the Toodo server");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Look" })).toBeEnabled();

    up = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));

    await vi.waitFor(() => expect(banner).not.toBeInTheDocument());
    expect(screen.getByLabelText("Draft")).toHaveValue(
      "typed before the outage",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});
