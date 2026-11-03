import type { Timestamp } from "@/lib/bindings";
import { formatFull, formatWhen } from "@/lib/timeline";

/** A moment in the app's one format: relative or a short date, the full time in the tooltip. */
export function When({ at, prefix = "", className }: { at: Timestamp; prefix?: string; className?: string }) {
  return (
    <time className={className} dateTime={new Date(at * 1000).toISOString()} title={formatFull(at)}>
      {`${prefix}${formatWhen(at)}`}
    </time>
  );
}
