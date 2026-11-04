/** A keyboard shortcut as listed in the shortcuts help: key names to press, and what they do. */
export type Shortcut = { keys: string[]; description: string };

/** The web app's keyboard shortcuts, shown by `?` and listed in the README. */
export const shortcuts: Shortcut[] = [
  { keys: ["Ctrl+K", "Cmd+K"], description: "Open the command palette: jump to a task or run an action" },
  { keys: ["j", "k"], description: "Select the next or previous task in the list or on the timeline" },
  { keys: ["Enter"], description: "Open the details of the selected task" },
  { keys: ["Esc"], description: "Close the details, the palette, or a dialog" },
  { keys: ["/"], description: "Search tasks" },
  { keys: ["?"], description: "Show these shortcuts" },
  { keys: ["Up", "Down", "Home", "End"], description: "On a timeline bar, move the selection between rows" },
];

/** Whether `target` takes typed text, so letters typed there must stay text. */
export function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']") !== null)
  );
}

/** Ctrl+K, or Cmd+K on a Mac: opens the command palette from anywhere, also from a field. */
export function isPaletteKey(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
}

/** Whether a dialog or menu that owns the keyboard is open over the page. */
function overlayOpen(): boolean {
  return [...document.querySelectorAll("[aria-modal='true'], [role=menu]")].some(
    (element) => element.closest("[hidden]") === null,
  );
}

/**
 * Whether a single-key shortcut such as `j` or `/` may act on `event`: nothing handled it yet,
 * no Ctrl, Cmd or Alt is held, it was not typed into a field, and no dialog or menu is open.
 */
export function singleKeyShortcut(event: KeyboardEvent): boolean {
  return (
    !event.defaultPrevented &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !isTypingTarget(event.target) &&
    !overlayOpen()
  );
}
