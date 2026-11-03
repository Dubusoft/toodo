import type { ShownStatus } from "@/lib/task-filter";

/**
 * The one glossary for statuses: chips, the timeline legend, the status filter, history and
 * Review all use these names, so one state never goes by two names.
 */
export const statusNames: Record<ShownStatus, string> = {
  // A planned task that cannot start yet, because a prerequisite is not done.
  planned: "Blocked",
  ready: "Ready",
  paused: "Paused",
  in_progress: "In progress",
  in_review: "Awaiting completion",
  done: "Done",
  not_adopted: "Not adopted",
};

/** The timeline mark at the time a task was planned; not a status. */
export const plannedOnName = "Planned on";

/**
 * The one colour map for states shown across the app: status chips, timeline bars, the
 * legend, banners, and notes. Each tone has a single meaning:
 *
 * - `neutral`: nothing to act on (blocked or waiting, idle, not adopted).
 * - `info`: something running on its own (agent working, CI running, update available).
 * - `progress`: work in progress.
 * - `review`: waiting in review.
 * - `success`: finished well (done, CI passed, approved).
 * - `attention`: the user can or should act (ready, agent needs input, blocker,
 *   changes requested, a confirm step).
 * - `danger`: something went wrong or is late (past due, CI failed, merge conflicts).
 *
 * Task types are not states: they use `typeChip`, outlined and without any of these hues.
 */
export type Tone = "neutral" | "info" | "progress" | "review" | "success" | "attention" | "danger";

/** Filled chips and pills. */
export const toneChip: Record<Tone, string> = {
  // Muted foreground on muted is under 4.5:1 in the light theme.
  neutral: "bg-muted text-foreground/70",
  info: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  progress: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  review: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
  success: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  attention: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  danger: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
};

/** Text on the page background, at least 4.5:1 in both themes. */
export const toneText: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  info: "text-sky-700 dark:text-sky-300",
  progress: "text-blue-700 dark:text-blue-300",
  review: "text-violet-700 dark:text-violet-300",
  success: "text-emerald-700 dark:text-emerald-300",
  attention: "text-amber-700 dark:text-amber-300",
  danger: "text-rose-700 dark:text-rose-300",
};

/** Outlined chips, such as a dependency that was not adopted. */
export const toneOutline: Record<Tone, string> = {
  neutral: "border-border text-muted-foreground",
  info: "border-sky-300 text-sky-700 dark:border-sky-800 dark:text-sky-300",
  progress: "border-blue-300 text-blue-700 dark:border-blue-800 dark:text-blue-300",
  review: "border-violet-300 text-violet-700 dark:border-violet-800 dark:text-violet-300",
  success: "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300",
  attention: "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300",
  danger: "border-rose-300 text-rose-700 dark:border-rose-800 dark:text-rose-300",
};

/** Task type chips: outlined and neutral, so a type never reads as a status. */
export const typeChip = "border-input text-foreground/70";

/** Banners and confirm steps. */
export const tonePanel: Record<"info" | "attention", string> = {
  info: "border border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100",
  attention:
    "border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100",
};

/** Small solid marks: status dots, legend swatches, timeline phase strips. */
export const toneFill: Record<Tone, string> = {
  neutral: "bg-neutral-400",
  info: "bg-sky-500",
  progress: "bg-blue-500",
  review: "bg-violet-500",
  success: "bg-emerald-500",
  attention: "bg-amber-500",
  danger: "bg-rose-500",
};

/** Thin vertical marks on the timeline, such as the time a task became ready. */
export const toneMark: Record<Tone, string> = {
  neutral: "border-muted-foreground",
  info: "border-sky-500",
  progress: "border-blue-500",
  review: "border-violet-500",
  success: "border-emerald-500",
  attention: "border-amber-500",
  danger: "border-rose-500 dark:border-rose-400",
};

/** Timeline bar styles by state; they are layered over the base bar. */
export const barStyles = {
  /** Finished: tinted green; the phase strip still shows how the work went. */
  done: "border-emerald-500 bg-emerald-100 dark:bg-emerald-950",
  /** Not started yet, with every prerequisite done: solid. */
  ready: "border-amber-500 shadow-none",
  /** Not started yet and still blocked: dashed. */
  blocked: "border-dashed border-muted-foreground shadow-none",
  /** Paused by hand: a muted fill and a dashed edge, with text kept at full contrast. */
  paused: "border-dashed border-muted-foreground bg-muted shadow-none",
  /** Done after its due date, or still open after it. */
  behindDue: "border-2 border-rose-500 dark:border-rose-400",
} as const;

/** The current-time cursor: neutral, so it never reads as a status. */
export const nowLine = "border-foreground/70";
export const nowLabel = "text-foreground";
