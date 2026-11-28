import type { Timestamp } from "@/lib/bindings";
import { useI18n } from "@/lib/i18n";
import { formatFull, formatWhen } from "@/lib/timeline";

/** A moment in the app's one format: relative or a short date, the full time in the tooltip. */
export function When({ at, prefix = "", className }: { at: Timestamp; prefix?: string; className?: string }) {
  const { locale, m } = useI18n();
  return (
    <time className={className} dateTime={new Date(at * 1000).toISOString()} title={formatFull(at, locale)}>
      {`${prefix}${formatWhen(at, undefined, locale, m)}`}
    </time>
  );
}
