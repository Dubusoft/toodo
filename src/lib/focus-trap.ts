/** Wraps Tab and Shift+Tab around the ends of a modal, so focus cannot leave it. */
export function keepFocusIn(container: HTMLElement | null, event: KeyboardEvent) {
  if (container === null) return;
  const focusable = [
    ...container.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, summary, [tabindex]"),
  ].filter((element) => !element.matches(":disabled, [tabindex='-1']") && element.getClientRects().length > 0);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  const inside = active instanceof Node && container.contains(active);
  if (event.shiftKey ? !inside || active === first : !inside || active === last) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}
