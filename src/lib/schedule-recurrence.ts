// The scheduled jobs panel's schedule picker: the cron expressions it can show as a sentence
// and edit with pickers (every hour, day, chosen weekdays, or day of the month at a time),
// and the sentences, in Korean or English. A job is still stored as its cron expression.
import type { ScheduledJob, ScheduleTimeZone } from "@/lib/supervisor-schedules";

export type Recurrence =
  | { readonly kind: "hourly"; readonly minute: number }
  | { readonly kind: "daily"; readonly hour: number; readonly minute: number }
  | { readonly kind: "weekly"; readonly days: readonly number[]; readonly hour: number; readonly minute: number }
  | { readonly kind: "monthly"; readonly day: number; readonly hour: number; readonly minute: number };

export type Language = "ko" | "en";

const ALIASES: Readonly<Record<string, string>> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

function int(text: string, lo: number, hi: number): number | null {
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return value >= lo && value <= hi ? value : null;
}

/** Weekdays 0 (Sunday) to 6 from a cron day-of-week list of numbers and ranges; 7 is Sunday too. */
function weekdays(text: string): number[] | null {
  const days = new Set<number>();
  for (const part of text.split(",")) {
    const [from, to] = part.split("-");
    const start = int(from ?? "", 0, 7);
    const end = to === undefined ? start : int(to, 0, 7);
    if (start === null || end === null || start > end || part.split("-").length > 2) return null;
    for (let day = start; day <= end; day++) days.add(day % 7);
  }
  return [...days].sort((a, b) => a - b);
}

/** What the pickers make of `cron`; `null` when they cannot show it (steps, hour ranges, months, ...). */
export function parseRecurrence(cron: string): Recurrence | null {
  const text = ALIASES[cron.trim()] ?? cron.trim();
  const fields = text.split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields as [string, string, string, string, string];
  const minute = int(minuteField, 0, 59);
  if (minute === null || monthField !== "*") return null;
  if (hourField === "*") return dayField === "*" && weekdayField === "*" ? { kind: "hourly", minute } : null;
  const hour = int(hourField, 0, 23);
  if (hour === null) return null;
  if (dayField === "*" && weekdayField === "*") return { kind: "daily", hour, minute };
  if (dayField === "*") {
    const days = weekdays(weekdayField);
    if (days === null) return null;
    return days.length === 7 ? { kind: "daily", hour, minute } : { kind: "weekly", days, hour, minute };
  }
  if (weekdayField !== "*") return null;
  const day = int(dayField, 1, 31);
  return day === null ? null : { kind: "monthly", day, hour, minute };
}

export function recurrenceCron(recurrence: Recurrence): string {
  switch (recurrence.kind) {
    case "hourly":
      return `${recurrence.minute} * * * *`;
    case "daily":
      return `${recurrence.minute} ${recurrence.hour} * * *`;
    case "weekly":
      return `${recurrence.minute} ${recurrence.hour} * * ${recurrence.days.join(",")}`;
    case "monthly":
      return `${recurrence.minute} ${recurrence.hour} ${recurrence.day} * *`;
  }
}

const WEEKDAYS: Readonly<Record<Language, readonly string[]>> = {
  ko: ["일", "월", "화", "수", "목", "금", "토"],
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};

export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export function weekdayName(day: number, language: Language): string {
  return WEEKDAYS[language][day] ?? String(day);
}

const twoDigits = (value: number): string => String(value).padStart(2, "0");

/** "오전 4:00" or "4:00 AM". */
export function clockTime(hour: number, minute: number, language: Language): string {
  const twelve = hour % 12 || 12;
  return language === "ko"
    ? `${hour < 12 ? "오전" : "오후"} ${twelve}:${twoDigits(minute)}`
    : `${twelve}:${twoDigits(minute)} ${hour < 12 ? "AM" : "PM"}`;
}

/** "매일 오전 4:00 (KST)" or "Every day at 4:00 AM (KST)". */
export function describeRecurrence(recurrence: Recurrence, zone: ScheduleTimeZone, language: Language): string {
  const ko = language === "ko";
  if (recurrence.kind === "hourly") {
    if (ko) return recurrence.minute === 0 ? "매시간 정각" : `매시간 ${recurrence.minute}분`;
    return `Every hour at :${twoDigits(recurrence.minute)}`;
  }
  const at = `${clockTime(recurrence.hour, recurrence.minute, language)} (${zone.label})`;
  switch (recurrence.kind) {
    case "daily":
      return ko ? `매일 ${at}` : `Every day at ${at}`;
    case "weekly": {
      const days = WEEK_ORDER.filter((day) => recurrence.days.includes(day)).map((day) => weekdayName(day, language));
      return ko ? `매주 ${days.join("·")}요일 ${at}` : `Every ${days.join(", ")} at ${at}`;
    }
    case "monthly":
      return ko ? `매월 ${recurrence.day}일 ${at}` : `Every month on day ${recurrence.day} at ${at}`;
  }
}

function describeInterval(seconds: number, language: Language): string {
  const [count, unit] =
    seconds % 3600 === 0 ? [seconds / 3600, "hour"] : seconds % 60 === 0 ? [seconds / 60, "minute"] : [seconds, "second"];
  if (language === "ko") return `${count}${{ hour: "시간", minute: "분", second: "초" }[unit]}마다`;
  return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`;
}

/**
 * A job's schedule as the panel lists it: a sentence when the pickers can show it in the
 * display time zone, else its cron expression and time zone as they are (`raw`).
 */
export function describeSchedule(job: ScheduledJob, zone: ScheduleTimeZone, language: Language): { readonly text: string; readonly raw: boolean } {
  if (job.everySec !== null) return { text: describeInterval(job.everySec, language), raw: false };
  const recurrence = job.cron !== null && job.tz === zone.name ? parseRecurrence(job.cron) : null;
  if (recurrence !== null) return { text: describeRecurrence(recurrence, zone, language), raw: false };
  return { text: `${job.cron ?? ""} (${job.tz})`, raw: true };
}

/** The language the panel's schedule text follows: Korean on a Korean browser, else English. */
export function browserLanguage(): Language {
  return navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en";
}
