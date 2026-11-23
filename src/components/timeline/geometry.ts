/** Height of the axis header: a row of coarse ticks above a row of fine ticks. */
export const axisRowHeight = 18;
export const axisHeight = 2 * axisRowHeight;
export const rowsTop = axisHeight + 8;
export const rowHeight = 40;
export const barHeight = 30;

/**
 * Width of the floating task details sheet, and its distance from the window edges. In a narrow
 * window the sheet takes at most `sheetShare` of it, but never less than `sheetMinWidth`.
 */
export const sheetWidth = 480;
export const sheetMinWidth = 360;
export const sheetShare = 0.4;
export const sheetMargin = 16;

export function sheetWidthIn(windowWidth: number): number {
  return Math.min(sheetWidth, Math.max(sheetMinWidth, windowWidth * sheetShare), windowWidth - 2 * sheetMargin);
}

/** How long the view takes to pan, which is no time at all for a user who asks for less motion. */
export function panDuration(): number {
  return (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false) ? 0 : 200;
}
