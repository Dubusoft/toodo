import type { TaskResolution, TaskStatus } from "@/lib/bindings";
import type { Locale } from "@/lib/i18n";
import { formatFull } from "@/lib/timeline";
import type { Messages } from "@/locales/en";

/**
 * A sentence the server wrote, in the app's language. The server writes the notes and status
 * reasons it records on its own (`Paused: ...`, `Waiting until ...`), why the latest automatic
 * backup failed, and why a push notification did not reach a device in English, for agents and
 * its log, and stores them as text. This knows those sentences by their fixed wording (see
 * `server/src/mcp/tools/lifecycle.ts`, `server/src/storage/task-waits.ts`,
 * `server/src/storage/task-dependencies.ts`, `server/src/commands/tasks.ts`,
 * `server/src/commands/backup.ts`, and `describeSendError` in `server/src/push/push.ts`) and
 * shows them from the catalog. Any other text, such as a note an agent wrote, stays as it is.
 */
export function serverText(text: string, m: Messages, locale: Locale): string {
  const copy = m.app.serverText;
  const time = (value: string) => waitTime(value, locale);
  const tasks = (list: string) => taskList(list, m);
  let match: RegExpMatchArray | null;

  if ((match = text.match(/^Paused: waiting on ([\s\S]+)$/))) return copy.pausedWaitingOn(tasks(match[1]));
  if ((match = text.match(/^Paused: ([\s\S]+)$/))) return copy.paused(match[1]);
  if ((match = text.match(/^Resumed: ([\s\S]+)$/))) return copy.resumed(match[1]);
  if ((match = text.match(/^Reopened: ([\s\S]*?)(?:\nIt was done as (merged|completed|not_adopted)(?:\.|: ([\s\S]*)))?$/))) {
    const reopened = copy.reopened(match[1]);
    if (match[2] === undefined) return reopened;
    const resolution = m.details.resolution[match[2] as TaskResolution];
    return `${reopened}\n${copy.wasDoneAs(resolution, match[3] ?? null)}`;
  }
  if ((match = text.match(new RegExp(`^Wait changed: waiting until (${WAIT_TIME})(?:: ([\\s\\S]*))?$`)))) {
    return copy.waitChanged(time(match[1]), match[2] ?? null);
  }
  if ((match = text.match(new RegExp(`^Waiting until (${WAIT_TIME})(?:: ([\\s\\S]*))?$`)))) {
    return copy.waitingUntil(time(match[1]), match[2] ?? null);
  }
  if ((match = text.match(/^Wait ended early(?:: ([\s\S]*))?$/))) return copy.waitEndedEarly(match[1] ?? null);
  if ((match = text.match(new RegExp(`^Wait until (${WAIT_TIME}) ended$`)))) return copy.waitEnded(time(match[1]));
  if ((match = text.match(/^The wait ended, but the task stays paused: waiting on ([\s\S]+)$/))) {
    return copy.waitEndedStillPaused(tasks(match[1]));
  }
  if ((match = text.match(/^Waiting on ([\s\S]+)$/))) return copy.waitingOn(tasks(match[1]));
  if ((match = text.match(/^could not back up into ([\s\S]+?): ([\s\S]+); make that directory writable for the toodo-server user, or choose another one under Settings > Backup & restore$/))) {
    return copy.backupFailed(match[1], match[2]);
  }
  if (text === "the push service no longer knows this subscription") return copy.pushGone;
  if ((match = text.match(/^the push service refused the notification \((\d+)\): ([\s\S]*)$/))) {
    return copy.pushRefused(match[1], match[2]);
  }
  if ((match = text.match(/^cannot reach the push service: ([\s\S]+)$/))) return copy.pushUnreachable(match[1]);
  return text;
}

/** A wait's time as the server writes it: RFC 3339 in UTC, or Unix seconds out of its range. */
const WAIT_TIME = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z|-?\\d+";

function waitTime(value: string, locale: Locale): string {
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? value : formatFull(millis / 1000, locale);
}

/** Prerequisites as the server lists them, `#3 Title (in_progress), #4 (done)`, with their statuses named. */
function taskList(list: string, m: Messages): string {
  return list.replace(/\((planned|in_progress|in_review|done)\)(?=,|$)/g, (_, status: TaskStatus) => `(${m.alerts.statuses[status]})`);
}
