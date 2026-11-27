import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DoriConfigPanel } from "@/components/dori-config-panel";
import type { DoriConfigEntry, DoriConfigView } from "@/lib/dori-config";
import { chooseOption } from "@/test/app";
import { fetchDoriConfig, saveDoriConfig } from "@/web/dori-config";

vi.mock("@/web/dori-config", () => ({ fetchDoriConfig: vi.fn(), saveDoriConfig: vi.fn() }));

const fetched = vi.mocked(fetchDoriConfig);
const saved = vi.mocked(saveDoriConfig);

const entry = (key: string, value: string, over: Partial<DoriConfigEntry> = {}): DoriConfigEntry => ({
  key, kind: "string", describe: `${key} help`, values: null, required: false, value, access: "edit", restart: false, ...over,
});

const view = (language: string, model = "a/b"): DoriConfigView => ({
  path: "/home/a/.dori/config.json",
  present: true,
  error: null,
  entries: [
    entry("ownerLanguage", language),
    entry("defaultModel", model, { required: true }),
    entry("agentCommand", "omo,{prompt}", { kind: "list", access: "readOnly" }),
    entry("secretCommands", "deploy", { kind: "json", access: "masked" }),
    entry("discord", "", { kind: "json", restart: true }),
  ],
});

function renderPanel(active = true) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DoriConfigPanel active={active} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetched.mockReset();
  saved.mockReset();
});

describe("DoriConfigPanel", () => {
  it("asks the server only while shown", () => {
    renderPanel(false);
    expect(fetched).not.toHaveBeenCalled();
  });

  it("switches the language with the Language option", async () => {
    fetched.mockResolvedValue(view("Korean"));
    saved.mockResolvedValue({ view: view("Japanese"), restart: false });
    renderPanel();
    chooseOption(await screen.findByRole("combobox", { name: /Language/ }), "Japanese");
    await waitFor(() => expect(saved).toHaveBeenCalledWith({ key: "ownerLanguage", value: "Japanese" }));
    expect(await screen.findByText("Saved. Dori applies it now, without a restart.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Language/ })).toHaveTextContent("Japanese");
  });

  it("saves an edited key and shows the server's reason when it refuses one", async () => {
    fetched.mockResolvedValue(view("Korean"));
    saved.mockRejectedValueOnce(new Error("defaultModel must not be empty"));
    saved.mockResolvedValueOnce({ view: view("Korean", "x/y"), restart: false });
    renderPanel();
    const row = await screen.findByRole("listitem", { name: "Config defaultModel" });
    fireEvent.change(within(row).getByRole("textbox", { name: /defaultModel/ }), { target: { value: " " } });
    fireEvent.click(within(row).getByRole("button", { name: "Save defaultModel" }));
    expect(await within(row).findByText("defaultModel must not be empty")).toBeInTheDocument();
    fireEvent.change(within(row).getByRole("textbox", { name: /defaultModel/ }), { target: { value: "x/y" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save defaultModel" }));
    await waitFor(() => expect(saved).toHaveBeenLastCalledWith({ key: "defaultModel", value: "x/y" }));
    const updated = await screen.findByRole("listitem", { name: "Config defaultModel" });
    expect(within(updated).getByRole("textbox", { name: /defaultModel/ })).toHaveValue("x/y");
  });

  it("offers no save for host-only and hidden keys, and marks keys that need a restart", async () => {
    fetched.mockResolvedValue(view("Korean"));
    renderPanel();
    for (const key of ["agentCommand", "secretCommands"]) {
      const row = await screen.findByRole("listitem", { name: `Config ${key}` });
      const field = within(row).getByRole("textbox", { name: new RegExp(key) });
      expect(field).toHaveAttribute("readonly");
      fireEvent.change(field, { target: { value: "changed" } });
      expect(within(row).queryByRole("button", { name: `Save ${key}` })).toBeNull();
    }
    expect(within(screen.getByRole("listitem", { name: "Config secretCommands" })).getByText("Hidden")).toBeInTheDocument();
    expect(within(screen.getByRole("listitem", { name: "Config discord" })).getByText("Restart to apply")).toBeInTheDocument();
  });
});
