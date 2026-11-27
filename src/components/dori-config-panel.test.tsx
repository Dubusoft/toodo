import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DoriConfigPanel, LanguageSettingField } from "@/components/dori-config-panel";
import type { DoriConfigEntry, DoriConfigView } from "@/lib/dori-config";
import { I18nProvider, useLocaleFromSettings, useMessages } from "@/lib/i18n";
import { ko } from "@/locales/ko";
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

/** The General section's Language field beside a heading in the UI language, as the app follows it. */
function LocalizedLanguageField() {
  useLocaleFromSettings();
  return (
    <>
      <h2>{useMessages().settings.title}</h2>
      <LanguageSettingField />
    </>
  );
}

function renderLanguageField() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider>
        <LocalizedLanguageField />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetched.mockReset();
  saved.mockReset();
  localStorage.clear();
});

describe("LanguageSettingField", () => {
  it("switches the language with the Language option", async () => {
    fetched.mockResolvedValue(view("English"));
    saved.mockResolvedValue({ view: view("Japanese"), restart: false });
    renderLanguageField();
    chooseOption(await screen.findByRole("combobox", { name: /Language/ }), "Japanese");
    await waitFor(() => expect(saved).toHaveBeenCalledWith({ key: "ownerLanguage", value: "Japanese" }));
    expect(await screen.findByText("Saved. Dori applies it now, without a restart.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Language/ })).toHaveTextContent("Japanese");
  });

  it("switches the app's screens to Korean and back to English without a reload", async () => {
    fetched.mockResolvedValue(view("English"));
    saved.mockResolvedValueOnce({ view: view("Korean"), restart: false });
    saved.mockResolvedValueOnce({ view: view("English"), restart: false });
    renderLanguageField();
    chooseOption(await screen.findByRole("combobox", { name: /Language/ }), "Korean");
    expect(await screen.findByRole("heading", { name: ko.settings?.title })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: new RegExp(ko.settings?.language ?? "") })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("ko");
    chooseOption(screen.getByRole("combobox"), ko.settings?.languageNames?.English ?? "");
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
  });

  it("shows nothing on a server without Dori", async () => {
    fetched.mockRejectedValue(new Error("Not Found"));
    renderLanguageField();
    await waitFor(() => expect(fetched).toHaveBeenCalled());
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });
});

describe("DoriConfigPanel", () => {
  it("asks the server only while shown", () => {
    renderPanel(false);
    expect(fetched).not.toHaveBeenCalled();
  });

  it("leaves the language to the General section", async () => {
    fetched.mockResolvedValue(view("Korean"));
    renderPanel();
    await screen.findByRole("listitem", { name: "Config defaultModel" });
    expect(screen.queryByRole("combobox", { name: /Language/ })).toBeNull();
    expect(screen.queryByRole("listitem", { name: "Config ownerLanguage" })).toBeNull();
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
