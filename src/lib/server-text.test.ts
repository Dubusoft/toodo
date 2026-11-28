import { describe, expect, it } from "vitest";
import { messagesFor } from "@/lib/i18n";
import { serverText } from "@/lib/server-text";

const ko = messagesFor("ko");
const en = messagesFor("en");

describe("serverText", () => {
  it("shows the notes the server records on its own in Korean", () => {
    expect(serverText("Paused: Waiting for the API design", ko, "ko")).toBe("일시 중지: Waiting for the API design");
    expect(serverText("Resumed: Ready again", ko, "ko")).toBe("재개: Ready again");
    expect(serverText("Paused: waiting on #3 Build API (in_progress), #4 (planned)", ko, "ko")).toBe(
      "일시 중지: #3 Build API (진행 중), #4 (계획됨) 대기 중",
    );
    expect(serverText("Reopened: Broke the login\nIt was done as merged: Shipped in #12", ko, "ko")).toBe(
      "다시 열림: Broke the login\n이전 결과(병합됨): Shipped in #12",
    );
    expect(serverText("Wait ended early", ko, "ko")).toBe("대기를 일찍 끝냄");
  });

  it("shows the time of a wait in the app's language, after words so Markdown does not read it as a list", () => {
    const shown = serverText("Waiting until 2026-11-10T00:00:00Z: Vendor reply", ko, "ko");

    expect(shown).toMatch(/^대기 중\(.+까지\): Vendor reply$/);
    expect(shown).not.toContain("2026-11-10T00:00:00Z");
    expect(serverText("Wait until 2026-11-10T00:00:00Z ended", ko, "ko")).toMatch(/^대기가 끝남\(.+까지\)$/);
  });

  it("shows a failed automatic backup and push delivery in Korean, keeping their details", () => {
    expect(
      serverText(
        "could not back up into /srv/backups: file error: Not a directory (os error 20); make that directory writable for the toodo-server user, or choose another one under Settings > Backup & restore",
        ko,
        "ko",
      ),
    ).toBe(
      "/srv/backups에 백업하지 못했습니다(file error: Not a directory (os error 20)). toodo-server 사용자가 이 디렉터리에 쓸 수 있게 하거나, 설정 > 백업 및 복원에서 다른 디렉터리를 선택하세요.",
    );
    expect(serverText("the push service refused the notification (403): nope", ko, "ko")).toBe(
      "푸시 서비스가 알림을 거부했습니다(403): nope",
    );
  });

  it("keeps text it does not know, and the server's English in English", () => {
    expect(serverText("Rebased onto dev; CI is green", ko, "ko")).toBe("Rebased onto dev; CI is green");
    expect(serverText("Paused: Waiting for the API design", en, "en")).toBe("Paused: Waiting for the API design");
  });
});
