import { afterEach, describe, expect, it } from "vitest";
import { initPanelSizes, loadPanelSizes, savePanelSize } from "@/lib/panel-sizes";

const root = document.documentElement.style;

afterEach(() => {
  localStorage.clear();
  root.cssText = "";
});

describe("panel sizes", () => {
  it("shows a saved size on the root and restores it at the next start", () => {
    savePanelSize("chat-width", 640.4);
    expect(root.getPropertyValue("--chat-width-saved")).toBe("640px");

    root.cssText = "";
    initPanelSizes();
    expect(root.getPropertyValue("--chat-width-saved")).toBe("640px");
    expect(loadPanelSizes()).toEqual({ "chat-width": 640 });
  });

  it("brings back the default size when one is reset", () => {
    savePanelSize("details-width", 500);
    savePanelSize("chat-height", 600);
    savePanelSize("details-width", null);
    expect(root.getPropertyValue("--details-width-saved")).toBe("");
    expect(loadPanelSizes()).toEqual({ "chat-height": 600 });
    savePanelSize("chat-height", null);
    expect(localStorage.getItem("toodo-panel-sizes")).toBeNull();
  });

  it("ignores anything saved that is not a size", () => {
    localStorage.setItem("toodo-panel-sizes", "not json");
    expect(loadPanelSizes()).toEqual({});
    localStorage.setItem(
      "toodo-panel-sizes",
      JSON.stringify({ "chat-width": "640px", "chat-height": -1, "details-width": 1e6, other: 5, "chat-beside-width": 420 }),
    );
    expect(loadPanelSizes()).toEqual({});
  });
});
