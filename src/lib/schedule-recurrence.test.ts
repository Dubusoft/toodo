import { describe, expect, it } from "vitest";
import { describeRecurrence, describeSchedule, parseRecurrence, recurrenceCron } from "@/lib/schedule-recurrence";
import type { ScheduledJob } from "@/lib/supervisor-schedules";

const KST = { name: "Asia/Seoul", label: "KST" };

const job = (fields: Partial<ScheduledJob>): ScheduledJob => ({
  name: "digest", kind: "GMAIL_DIGEST", cron: "0 6 * * *", everySec: null, tz: "Asia/Seoul",
  text: null, command: null, cwd: null, machine: null, heavy: false, catchUp: "once", paused: false,
  nextRunAt: null, lastRunAt: null, lastResult: null, waiting: null, error: null,
  ...fields,
});

describe("schedule recurrence", () => {
  it("reads the cron expressions the pickers can show and writes them back", () => {
    const cases: [string, ReturnType<typeof parseRecurrence>, string][] = [
      ["0 4 * * *", { kind: "daily", hour: 4, minute: 0 }, "0 4 * * *"],
      ["@daily", { kind: "daily", hour: 0, minute: 0 }, "0 0 * * *"],
      ["15 * * * *", { kind: "hourly", minute: 15 }, "15 * * * *"],
      ["30 9 * * 3,1", { kind: "weekly", days: [1, 3], hour: 9, minute: 30 }, "30 9 * * 1,3"],
      ["0 9 * * 1-5", { kind: "weekly", days: [1, 2, 3, 4, 5], hour: 9, minute: 0 }, "0 9 * * 1,2,3,4,5"],
      ["0 18 * * 6,7", { kind: "weekly", days: [0, 6], hour: 18, minute: 0 }, "0 18 * * 0,6"],
      ["0 9 * * 0-6", { kind: "daily", hour: 9, minute: 0 }, "0 9 * * *"],
      ["0 9 1 * *", { kind: "monthly", day: 1, hour: 9, minute: 0 }, "0 9 1 * *"],
    ];
    for (const [cron, recurrence, written] of cases) {
      expect(parseRecurrence(cron)).toEqual(recurrence);
      expect(recurrenceCron(recurrence!)).toBe(written);
    }
  });

  it("leaves to Advanced what the pickers cannot show", () => {
    for (const cron of ["*/15 9-18 * * 1-5", "0 9-18 * * *", "0 9 1 1 *", "0 9 1 * 1", "0 9 * *", "0 24 * * *", "0 9 * * mon"]) {
      expect(parseRecurrence(cron)).toBeNull();
    }
  });

  it("says a schedule in Korean or English in the display time zone", () => {
    expect(describeRecurrence({ kind: "daily", hour: 4, minute: 0 }, KST, "ko")).toBe("매일 오전 4:00 (KST)");
    expect(describeRecurrence({ kind: "daily", hour: 4, minute: 0 }, KST, "en")).toBe("Every day at 4:00 AM (KST)");
    expect(describeRecurrence({ kind: "weekly", days: [0, 1, 3], hour: 21, minute: 30 }, KST, "ko")).toBe("매주 월·수·일요일 오후 9:30 (KST)");
    expect(describeRecurrence({ kind: "weekly", days: [0, 1, 3], hour: 21, minute: 30 }, KST, "en")).toBe("Every Mon, Wed, Sun at 9:30 PM (KST)");
    expect(describeRecurrence({ kind: "monthly", day: 1, hour: 12, minute: 5 }, KST, "ko")).toBe("매월 1일 오후 12:05 (KST)");
    expect(describeRecurrence({ kind: "hourly", minute: 0 }, KST, "ko")).toBe("매시간 정각");
    expect(describeRecurrence({ kind: "hourly", minute: 15 }, KST, "en")).toBe("Every hour at :15");
  });

  it("lists a job as a sentence, an interval, or its cron expression as it is", () => {
    expect(describeSchedule(job({}), KST, "ko")).toEqual({ text: "매일 오전 6:00 (KST)", raw: false });
    expect(describeSchedule(job({ cron: null, everySec: 7_200 }), KST, "ko")).toEqual({ text: "2시간마다", raw: false });
    expect(describeSchedule(job({ cron: null, everySec: 60 }), KST, "en")).toEqual({ text: "Every minute", raw: false });
    expect(describeSchedule(job({ cron: "*/15 9-18 * * 1-5" }), KST, "ko")).toEqual({ text: "*/15 9-18 * * 1-5 (Asia/Seoul)", raw: true });
    // In another zone than the display zone the time would read wrong as a sentence.
    expect(describeSchedule(job({ tz: "UTC" }), KST, "ko")).toEqual({ text: "0 6 * * * (UTC)", raw: true });
  });
});
