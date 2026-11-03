# UI/UX Review (October 2026)

> **Note:** The Windows desktop app was removed after this document was written. Toodo now
> has one client, the web app (PWA) served by `toodo-server`; see [server.md](server.md).
> This record is kept as it was.

A review of the Toodo frontend as of `dev` at 0.5.1 (`11c7d9b`), on 2026-10-16. It
records what the review found and what to fix. It is a snapshot: check a finding against
the current code before acting on it.

**Verdict: needs work.** Every flow is real and wired up. What needs fixing:

- The sidebar layout breaks when its panels are open.
- Labels collide with markers on the timeline.
- Keyboard focus has gaps.
- Unsaved edits are lost without confirmation.
- Several texts and states have too little contrast.

## Method

- **Surface:** the frontend ran in Chromium (`npx vite`) against a mocked Tauri IPC
  backend. The mock data covered:
  - 3 workspaces, one of them on an SSH machine.
  - 12 tasks covering every status: done and merged, done and not adopted, in review
    with failing CI, in review with changes requested, in progress with a blocked agent
    and a blocker note, paused with an open herdr workspace, planned (ready and
    blocked), a Korean title, and a very long title.
- **Pages (13):**
  - All workspaces timeline: the start view, a selected bar with the details sheet, and
    the hover card.
  - All workspaces list.
  - Workspace list view, and its inline edit form.
  - A remote workspace.
  - Review: week and year.
  - Sidebar panels expanded (Agent access, Backups).
  - The Add machine form.
  - The Clone form.
  - The empty state (no workspaces).
- **Matrix:** 96 captures:
  - All pages at 1280x800 (the default window) and 1440x900.
  - The core pages at 1920x1080 and 960x700 (a narrowed window).
  - Each in light and dark, plus scrolled-to-end shots.
- **Checklist:** a platform baseline distilled from Apple's Human Interface Guidelines
  (layout, hierarchy, text, targets, contrast, consistency, motion, states, keyboard).
  Toodo is a desktop-only Windows app, so phone and macOS-only items were not applicable.
- **Reviewers:** two independent read-only passes.
  - The first judged motion, states, keyboard, and the design system from the code.
  - The second judged the rendered captures. It opened 24 of the 96: every page in at
    least one theme, but not every light/dark pair.

## Must Fix

Ordered by priority.

### 1. The sidebar cannot scroll

With Agent access and Backups both expanded, the workspace list collapses to zero height
at 1280, and at 960 the Backups panel is cut off. Two things cause it:

- The `aside` in `App.tsx` never scrolls.
- The workspace list is `min-h-0 overflow-y-auto` (`workspace-list.tsx`), so it is the
  only part that gives up height.

Fix: let the whole `aside` scroll (`min-h-0 overflow-y-auto`), or give the workspace list
a minimum height and scroll the panel area instead.

### 2. Unsaved edits are lost without confirmation

Edits in progress are dropped silently by any of these:

- "Discard" in the inline edit form (`task-list.tsx`).
- Escape, "Close details", a pane click, or a click on another bar while editing in the
  timeline details sheet (`task-graph.tsx`).

Fix: track whether the edit form is dirty and ask before dropping changes ("Keep
editing" / "Discard"). Stop Escape inside form fields from closing the sheet.

### 3. Timeline labels collide with markers

- The right handle dot of a bar sits on the type chip.
- Due-date ticks cut through title letters.
- The workspace chip sits half on the bar.
- Some labels start with no gap after the bar.

Fix:

- Start labels at the bar end plus a fixed gap.
- Keep handles out of the chip area, or show them only on hover or selection.
- Draw the Now line and due ticks beneath the label layer, or clip them to the bar.

### 4. Keyboard focus has gaps

| Problem | Cause | Fix |
| --- | --- | --- |
| A bar focused with Tab shows no focus ring | `@xyflow/react` sets `outline: none` on `.react-flow__node:focus-visible`, and Toodo adds no replacement | Add a visible ring to the bar |
| Escape stops closing the details sheet | Escape is handled only on the timeline wrapper; clicking plain text in the sheet moves focus to `<body>` | Listen on `document` while the sheet is open, or move focus into the sheet |
| Escape does not dismiss the hover card | - | Close the hover card on Escape |
| Focus falls to `<body>` after Delete or Edit | The button unmounts | Move focus to the next sensible control, e.g. the confirm row's "Back" |
| Inline forms (edit, clone, add machine, confirms) ignore Escape | - | Close the form on Escape |

### 5. Status colours contradict each other

- The Now line is red and the past-due marker is rose: two reds with two meanings.
- The legend's "Ready" tick is green, while the "Ready" status chip is amber.
- A blocked agent is amber, but a blocker note is rose.

Fix: one status colour map (see Design System) used by badges, bars, and the legend.
Make the Now line a neutral or blue accent, rename the legend's ready tick (it marks when
a task became ready), and keep rose only for late and overdue.

### 6. Low contrast

WCAG AA asks for 4.5:1 for text and 3:1 for state indicators.

| Element | Estimate | Cause |
| --- | --- | --- |
| Paused bar title | ~2.8:1 | `opacity-60` on the whole bar |
| Paused bar chips | ~1.6:1 | `opacity-60` on the whole bar |
| "Now" label in light mode | ~3.6:1 | red-500 at 11 px |
| Disabled "Change" (base branch) | ~2:1 | |
| Disabled Start / Resume | ~2.5:1 | |
| Light-mode placeholders | borderline | |
| Selected toggles (Week, Timeline, Write) | well below 3:1 | Only a faint grey fill marks the selection |

Fix:

- Express "paused" through the bar style and keep text colours at least 4.5:1.
- Darken the Now label.
- Give selected toggles a stronger treatment: `bg-primary text-primary-foreground`, or a
  bordered segmented control.

### 7. Fields are labelled only by placeholders

The new-task form, the inline edit form, the Clone form, and the Add machine form name
their fields only through placeholders. In the edit form an estimate shows as a bare
"5", and the Add machine select is clipped to "Choose an SS".

Fix: add visible labels or persistent captions. Widen the Add machine select or shorten
its placeholder. Keep the task header ("#8 · Planned") above the edit form, which
currently replaces it.

### 8. Dates use three formats

| Where | Format |
| --- | --- |
| List rows and hover card | ISO dates, e.g. `2026-09-16` |
| Details sheet, notes, backups | Locale date and time with seconds, e.g. `10/16/2026, 6:03:19 AM` |
| Year review "Completed per month" | Monospace `2026-01` months, mostly zeros |

Pull request links also show the full URL.

Fix:

- One shared date formatter without seconds, with the full timestamp in a `title`.
- Month names in the year chart; collapse empty months.
- Show pull requests as `#3` with the URL on hover.

### 9. Narrow windows and layout shift

- **At 960 px:**
  - The fixed `w-64` sidebar truncates names ("build-b…").
  - The details sheet covers about three quarters of the timeline.
  - Legend items wrap inside themselves ("In / progress").
- **Layout shift:**
  - The start view first paints "Loading timeline..." while the lazy timeline chunk
    loads.
  - The update and herdr banners appear after their checks finish and push the main
    column down.

Fix:

- Keep each legend item on one line (`whitespace-nowrap`).
- Cap the sheet width relative to the window.
- Consider collapsing the sidebar below about 1100 px.
- Preload the timeline chunk, since it is the default view, or render a skeleton of the
  same size.
- Reserve space for the banners or overlay them.

### 10. Smaller items

- **Reduced motion:** the reveal pan (`task-graph.tsx`, 200 ms) and
  `active:translate-y-px` on `Button` ignore `prefers-reduced-motion`.
- **Empty state:** it says to create a workspace but has no Clone or Open button.
- **No cancel for long operations:** clone, open, and "Add to herdr" can take long and
  cannot be cancelled.
- **Missing tooltips:** the icon-only "Close details" and "Remove dependency" buttons
  have no tooltip.
- **"Close workspace" style:** it ends the agent session but is not styled destructive.
- **Small row actions:** the icon-only Pause, Edit, and Delete buttons are about 16 px,
  and Delete sits apart from the others.
- **Year review colours:** it uses several accent colours for its numbers.

## Design System

Both items cause most of the visual drift above. Fix them together with the colour and
contrast findings.

- **Status colours are not a system.** Raw Tailwind palette classes are spread across at
  least nine files: `task-list.tsx`, `task-graph.tsx`, `needs-attention.tsx`,
  `pull-request-badge.tsx`, `agent-badge.tsx`, `review.tsx`, `herdr-banner.tsx`,
  `update-banner.tsx`, and `prerequisite-confirmation.tsx`. The same rose chip classes
  are copied at least six times. Fix: move them into one module (e.g.
  `src/lib/status-styles.ts`) or CSS tokens (`--status-ready`, `--status-late`, ...).
- **Only `Button` is a shared primitive.** Inputs, selects, textareas, badges, and cards
  use ad-hoc classes, and `inputClass` and `compactSelectClass` are exported from
  `workspace-list.tsx` for reuse. This is why control heights differ between forms. Fix:
  add `Input`, `Select`, `Textarea`, `Badge`, and `Card` under `src/components/ui/`.

## Korean Text

The Korean task title renders without missing glyphs or clipping. No capture made it
wrap, so line breaking was not observed. Two risks remain:

- **Mid-word breaks.** There is no `word-break: keep-all` and the document is
  `lang="en"`, so at narrow widths a Korean title would break inside a word. Fix: set
  `word-break: keep-all` with `overflow-wrap: anywhere` on titles and descriptions.
- **Lighter Hangul.** Hangul renders lighter than the Latin titles beside it. Geist has
  no Hangul glyphs, and the Windows fallback (Malgun Gothic) only has regular and bold,
  so medium-weight titles fall back to regular. Fix: use semibold for titles, or add a
  Hangul font with a medium weight.

## Keep

The review found these correct; do not regress them.

- **Real components:** the UI is real DOM and Lucide SVG, with no raster stand-ins.
- **Themes:** light and dark both render correctly from shadcn tokens. The theme control
  offers System, and React Flow follows the theme.
- **Destructive actions:**
  - Delete and restore confirm in place.
  - After Delete, "Back" lands under the pointer, so a double-click cannot delete.
  - Restore asks before "Replace data".
  - A new prerequisite has its own confirm step before it pauses a running task.
- **Errors and alerts:** errors appear in the row they belong to, with their cause and
  `role="alert"`. Desktop alerts fire only while the window is unfocused.
- **Opaque overlays:** the details sheet and the hover card are opaque, so content
  scrolling underneath never shows through.
- **Timeline keyboard:**
  - Arrow keys and Home/End move the selection.
  - Tab focus pans a bar into view.
  - The hover card stays open long enough for the pointer to reach it.
- **Accessible names:** every input and icon button has one.

## Next Step

Fix items 1-6 and the status colour map in one change. Then re-capture the same matrix
and run an independent review again; the verdict passes only on fresh captures of every
page.
