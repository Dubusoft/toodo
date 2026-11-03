import { useEffect, useState } from "react";

// Below the md breakpoint (48rem).
const narrowQuery = "(max-width: 47.99rem)";

/** Whether the window is narrower than the md breakpoint, following resizes. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia(narrowQuery).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(narrowQuery);
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}
