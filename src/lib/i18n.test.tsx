import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fill, localeOf, messagesFor } from "@/lib/i18n";
import { en } from "@/locales/en";
import { ko, nativeNames } from "@/locales/ko";

describe("localeOf", () => {
  it("reads Korean by its English name, code, or native name", () => {
    for (const name of ["Korean", " korean ", "ko", "ko-KR", ...nativeNames]) expect(localeOf(name)).toBe("ko");
  });

  it("falls back to English for other languages and an unset language", () => {
    for (const name of ["English", "Japanese", "Chinese", "", null, undefined]) expect(localeOf(name)).toBe("en");
  });
});

describe("messagesFor", () => {
  it("shows a key the Korean catalog lacks in English", () => {
    expect(ko.settings?.hintJson).toBeUndefined();
    expect(messagesFor("ko").settings.hintJson).toBe(en.settings.hintJson);
    expect(messagesFor("ko").settings.title).toBe(ko.settings?.title);
  });

  it("is the English catalog itself for English", () => {
    expect(messagesFor("en")).toBe(en);
  });
});

describe("fill", () => {
  it("puts elements in place of their names and leaves an unknown name as written", () => {
    const { container } = render(<p>{fill("Run {command} on {host}, not {other}.", { command: <code>toodo update</code>, host: "the host" })}</p>);
    expect(container.innerHTML).toBe("<p>Run <code>toodo update</code> on the host, not {other}.</p>");
  });
});
