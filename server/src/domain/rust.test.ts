import { describe, expect, test } from "bun:test";

import { compareStrings, debugString, displayFloat, lines, trim } from "./rust.ts";

// Expected values are what the Rust server's standard library produced for the same input.
describe("rust", () => {
  test("strings are quoted the way {:?} quotes them", () => {
    expect(debugString("\u{7f}\0~")).toBe('"\\u{7f}\\0~"');
    expect(debugString("9+\n\u{a0}\u{200b}\u{e9}-\r`")).toBe('"9+\\n\\u{a0}\\u{200b}\u{e9}-\\r`"');
    expect(debugString('a "b" \\ 한 \u{301}')).toBe('"a \\"b\\" \\\\ 한 \\u{301}"');
  });

  test("floats are printed the way {} prints an f64", () => {
    expect(displayFloat(-0)).toBe("-0");
    expect(displayFloat(NaN)).toBe("NaN");
    expect(displayFloat(Infinity)).toBe("inf");
    expect(displayFloat(-Infinity)).toBe("-inf");
    expect(displayFloat(1e21)).toBe("1000000000000000000000");
    expect(displayFloat(1e-7)).toBe("0.0000001");
    expect(displayFloat(10000.000001)).toBe("10000.000001");
  });

  test("trim takes the White_Space characters only", () => {
    expect(trim("\u{85} Phone\u{3000}")).toBe("Phone");
    expect(trim("\u{feff}Phone")).toBe("\u{feff}Phone");
  });

  test("strings order by scalar value", () => {
    expect(["\u{1f600}", "\u{e000}"].sort(compareStrings)).toEqual(["\u{e000}", "\u{1f600}"]);
    expect(compareStrings("ab", "a")).toBeGreaterThan(0);
  });

  test("lines drop a carriage return and a final empty line", () => {
    expect(lines("a\r\nb\n")).toEqual(["a", "b"]);
    expect(lines("\n")).toEqual([""]);
    expect(lines("")).toEqual([]);
  });
});
