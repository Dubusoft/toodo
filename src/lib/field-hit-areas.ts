import { TOUCH_QUERY, useTouchHitArea } from "@astryxdesign/core/internal/touch";
import { useEffect, useState } from "react";

/**
 * The Astryx fields that draw no touch band of their own. `src/index.css` draws theirs from the
 * insets the watch writes on them.
 */
const FIELDS = ".astryx-selector, .astryx-date-input, .astryx-text-input";

/**
 * Under a finger, Astryx grows a button's touch target toward 44px, as far as its neighbours leave
 * room, but not a selector's, a date field's or a text field's. This gives those fields the same
 * watch: Astryx measures each field against its neighbours and writes how far its target may grow
 * on each side, and the field's invisible strips in `src/index.css` span that far. The hook comes
 * from Astryx's internal entry, which the exact `@astryxdesign/core` version in `package.json`
 * keeps stable.
 */
export function useFieldHitAreas() {
  const watch = useTouchHitArea(true);
  const [touch, setTouch] = useState(() => window.matchMedia(TOUCH_QUERY).matches);

  useEffect(() => {
    const query = window.matchMedia(TOUCH_QUERY);
    const onChange = () => setTouch(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!touch) return;
    const releases = new Map<Element, () => void>();
    const sync = () => {
      for (const [field, release] of releases) {
        if (!field.isConnected) {
          release();
          releases.delete(field);
        }
      }
      for (const field of document.querySelectorAll<HTMLElement>(FIELDS)) {
        if (releases.has(field)) continue;
        const release = watch(field);
        if (release) releases.set(field, release);
      }
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const release of releases.values()) release();
    };
  }, [touch, watch]);
}
