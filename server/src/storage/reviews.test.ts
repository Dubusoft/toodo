import { expect, test } from "bun:test";

import {
  type NewReviewSnapshot,
  deleteReviewSnapshot,
  listReviewSnapshots,
  reviewSnapshot,
  reviewTimeZone,
  saveReviewSnapshot,
  setReviewTimeZone,
} from "./reviews.ts";
import { openMemoryDatabase } from "./testing.ts";

function snapshot(title: string): NewReviewSnapshot {
  return {
    info: {
      title,
      period: "week",
      from: "2026-11-02",
      to: "2026-11-08",
      timeZone: "Asia/Seoul",
      workspaceId: null,
      label: "perf",
      startAt: 100,
      endAt: 200,
      entryCount: 1,
    },
    entries: '[{"id":1}]',
    workspaces: "[]",
    markdown: "# Week review",
    csv: "id\r\n1\r\n",
  };
}

test("the review time zone is set, replaced, and cleared", () => {
  const db = openMemoryDatabase();
  expect(reviewTimeZone(db)).toBeNull();
  setReviewTimeZone(db, "Asia/Seoul");
  setReviewTimeZone(db, "Europe/Berlin");
  expect(reviewTimeZone(db)).toBe("Europe/Berlin");
  setReviewTimeZone(db, null);
  expect(reviewTimeZone(db)).toBeNull();
});

test("snapshots are saved, listed newest first, read back, and deleted", () => {
  const db = openMemoryDatabase();
  const first = saveReviewSnapshot(db, snapshot("First"), 1000);
  const second = saveReviewSnapshot(db, snapshot("Second"), 2000);
  expect([first.createdAt, second.createdAt]).toEqual([1000, 2000]);

  expect(listReviewSnapshots(db).map((info) => info.title)).toEqual(["Second", "First"]);

  const read = reviewSnapshot(db, first.id);
  expect(read?.info).toEqual(first);
  const { id: _id, createdAt: _createdAt, ...described } = first;
  expect({ ...read, info: described }).toEqual(snapshot("First"));

  expect(deleteReviewSnapshot(db, first.id)).toBe(true);
  expect(deleteReviewSnapshot(db, first.id)).toBe(false);
  expect(reviewSnapshot(db, first.id)).toBeNull();
});
