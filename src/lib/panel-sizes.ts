/**
 * The sizes the owner gave the chat popup and a task's details sheet by dragging their edges, kept
 * in this browser. Each is saved for the arrangement it was set in: the chat alone or beside the
 * details, the details alone or beside the chat. A saved size is a CSS pixel length on the root
 * (`--<name>-saved`); `src/index.css` applies it only on desktop widths and clamps it to the window
 * there, so a panel without one keeps its default size and tablets and phones never see one.
 */

export type PanelSize = "chat-width" | "chat-beside-width" | "chat-height" | "details-width" | "details-beside-width";

const panelSizes: PanelSize[] = ["chat-width", "chat-beside-width", "chat-height", "details-width", "details-beside-width"];

const storageKey = "toodo-panel-sizes";

type Saved = Partial<Record<PanelSize, number>>;

/** The sizes saved in this browser, in pixels, leaving out anything saved that is not one. */
export function loadPanelSizes(): Saved {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (typeof saved !== "object" || saved === null) return {};
    const sizes: Saved = {};
    for (const name of panelSizes) {
      const size = (saved as Record<string, unknown>)[name];
      if (typeof size === "number" && size > 0 && size <= 10_000) sizes[name] = Math.round(size);
    }
    return sizes;
  } catch {
    // Anything else saved under the key is no size.
    return {};
  }
}

/** Shows `size` pixels as the panel's size, or its default for null, without saving it. */
export function showPanelSize(name: PanelSize, size: number | null) {
  const style = document.documentElement.style;
  if (size === null) style.removeProperty(`--${name}-saved`);
  else style.setProperty(`--${name}-saved`, `${Math.round(size)}px`);
}

/** Shows and saves `size` pixels as the panel's size; null brings back its default. */
export function savePanelSize(name: PanelSize, size: number | null) {
  showPanelSize(name, size);
  const sizes = loadPanelSizes();
  if (size === null) delete sizes[name];
  else sizes[name] = Math.round(size);
  if (Object.keys(sizes).length === 0) localStorage.removeItem(storageKey);
  else localStorage.setItem(storageKey, JSON.stringify(sizes));
}

/** Shows the saved sizes, at start. */
export function initPanelSizes() {
  const sizes = loadPanelSizes();
  for (const name of panelSizes) showPanelSize(name, sizes[name] ?? null);
}
