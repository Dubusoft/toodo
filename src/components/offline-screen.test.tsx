import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("ConnectionGate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("warns while the server is unreachable, pauses data changes, and clears once it answers", async () => {
    vi.resetModules();
    const { serverFetch } = await import("@/web/connection");
    const { Button } = await import("@/components/button");
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
      <QueryClientProvider client={new QueryClient()}>
        <ConnectionGate>
          <input aria-label="Draft" defaultValue="typed before the outage" />
          <Button changesData label="Save" />
          <Button label="Look" />
        </ConnectionGate>
      </QueryClientProvider>,
    );

    await act(async () => {
      await serverFetch("/api/rpc/list_tasks").catch(() => {});
    });

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Can't reach the Toodo server");
    // Astryx disables a button with aria-disabled, not the native attribute.
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Look" })).not.toHaveAttribute("aria-disabled", "true");

    up = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));

    await vi.waitFor(() => expect(banner).not.toBeInTheDocument());
    expect(screen.getByLabelText("Draft")).toHaveValue(
      "typed before the outage",
    );
    expect(screen.getByRole("button", { name: "Save" })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("tells when the tasks shown were loaded", async () => {
    vi.resetModules();
    const { serverFetch } = await import("@/web/connection");
    const { ConnectionGate } = await import("@/components/offline-screen");
    const { queryKeys } = await import("@/lib/queries");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const queryClient = new QueryClient();
    const loadedAt = Math.floor(Date.now() / 1000) - 3 * 60 * 60;
    queryClient.setQueryData(queryKeys.tasks, [], { updatedAt: loadedAt * 1000 });
    render(
      <QueryClientProvider client={queryClient}>
        <ConnectionGate>{null}</ConnectionGate>
      </QueryClientProvider>,
    );

    await act(async () => {
      await serverFetch("/api/rpc/list_tasks").catch(() => {});
    });

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Read-only");
    expect(banner.querySelector("time")).toHaveAttribute("dateTime", new Date(loadedAt * 1000).toISOString());
  });
});
