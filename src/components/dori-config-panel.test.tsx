import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppLanguageSettingField } from "@/components/app-language-setting";
import { DoriConfigPanel, DoriLanguageSettingField } from "@/components/dori-config-panel";
import { commands } from "@/lib/bindings";
import type { DoriConfigEntry, DoriConfigView } from "@/lib/dori-config";
import { I18nProvider, useLocaleFromSettings, useMessages } from "@/lib/i18n";
import { ko } from "@/locales/ko";
import { chooseOption } from "@/test/app";
import { fetchDoriConfig, saveDoriConfig } from "@/web/dori-config";

vi.mock("@/web/dori-config", () => ({ fetchDoriConfig: vi.fn(), saveDoriConfig: vi.fn() }));
vi.mock("@/lib/bindings", () => ({ commands: { getAppLanguage: vi.fn(), setAppLanguage: vi.fn() } }));

const fetched = vi.mocked(fetchDoriConfig);
const saved = vi.mocked(saveDoriConfig);
const appLanguage = vi.mocked(commands.getAppLanguage);
const setAppLanguage = vi.mocked(commands.setAppLanguage);

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

/** The General section's two language fields beside a heading in the UI language, as the app follows it. */
function LocalizedLanguageField() {
  useLocaleFromSettings();
  return (
    <>
      <h2>{useMessages().settings.title}</h2>
      <AppLanguageSettingField />
      <DoriLanguageSettingField />
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
  appLanguage.mockReset();
  setAppLanguage.mockReset();
  appLanguage.mockResolvedValue(null);
  setAppLanguage.mockImplementation(async (language) => language);
  localStorage.clear();
});

describe("language settings", () => {
  it("shows the screens in Dori's language while no app language is set", async () => {
    fetched.mockResolvedValue(view("Korean"));
    renderLanguageField();
    expect(await screen.findByRole("heading", { name: ko.settings?.title })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: new RegExp(ko.settings?.appLanguage ?? "") })).toHaveTextContent(
      ko.settings?.appLanguageFollowsDori ?? "",
    );
  });

  it("switches the screens with the app language and leaves Dori's language alone", async () => {
    fetched.mockResolvedValue(view("English"));
    renderLanguageField();
    chooseOption(await screen.findByRole("combobox", { name: /App language/ }), "Korean");
    expect(await screen.findByRole("heading", { name: ko.settings?.title })).toBeInTheDocument();
    expect(setAppLanguage).toHaveBeenCalledWith("ko");
    expect(document.documentElement.lang).toBe("ko");
    expect(screen.getByRole("combobox", { name: new RegExp(ko.settings?.doriLanguage ?? "") })).toHaveTextContent(
      ko.settings?.languageNames?.English ?? "",
    );
    chooseOption(screen.getByRole("combobox", { name: new RegExp(ko.settings?.appLanguage ?? "") }), ko.settings?.languageNames?.English ?? "");
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
    expect(saved).not.toHaveBeenCalled();
  });

  it("saves Dori's language and keeps the screens in theirs", async () => {
    fetched.mockResolvedValue(view("English"));
    saved.mockResolvedValue({ view: view("Korean"), restart: false });
    renderLanguageField();
    chooseOption(await screen.findByRole("combobox", { name: /Dori's language/ }), "Korean");
    await waitFor(() => expect(saved).toHaveBeenCalledWith({ key: "ownerLanguage", value: "Korean" }));
    expect(setAppLanguage).toHaveBeenCalledWith("en");
    expect(await screen.findByText("Saved. Dori applies it now, without a restart.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Dori's language/ })).toHaveTextContent("Korean");
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
  });

  it("offers only the app language on a server without Dori", async () => {
    fetched.mockRejectedValue(new Error("Not Found"));
    renderLanguageField();
    expect(await screen.findByRole("combobox", { name: /App language/ })).toHaveTextContent("Not set");
    expect(screen.queryByRole("combobox", { name: /Dori's language/ })).toBeNull();
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
