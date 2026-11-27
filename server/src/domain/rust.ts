// The text and number rules of Rust's standard library that the domain's messages and
// checks depend on, so the TypeScript domain reads and writes text exactly as the Rust
// server did: what counts as whitespace, how a string is quoted in an error message, how
// a float is printed, and how strings are ordered.

const WHITESPACE = /\p{White_Space}/u;
const LEADING_WHITESPACE = /^\p{White_Space}+/u;
const TRAILING_WHITESPACE = /\p{White_Space}+$/u;
const CONTROL = /\p{Cc}/u;
const ALPHANUMERIC = /[\p{Alphabetic}\p{N}]/u;
/** Characters `{:?}` writes as `\u{...}`: grapheme extenders and the non-printable ones. */
const ESCAPED_IN_DEBUG = /[\p{Grapheme_Extend}\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** `char::is_whitespace`: the Unicode `White_Space` property (unlike `String.trim`, it
 * leaves U+FEFF and takes U+0085). */
export function isWhitespace(char: string): boolean {
  return WHITESPACE.test(char);
}

/** `char::is_control`: general category `Cc`. */
export function isControl(char: string): boolean {
  return CONTROL.test(char);
}

/** `char::is_alphanumeric`: `Alphabetic` or a number. */
export function isAlphanumeric(char: string): boolean {
  return ALPHANUMERIC.test(char);
}

/** `str::trim`. */
export function trim(text: string): string {
  return trimEnd(trimStart(text));
}

/** `str::trim_end`. */
export function trimEnd(text: string): string {
  return text.replace(TRAILING_WHITESPACE, "");
}

/** `str::trim_start`. */
export function trimStart(text: string): string {
  return text.replace(LEADING_WHITESPACE, "");
}

/** `str::chars().count()`: the number of Unicode scalar values. */
export function charCount(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** `str::len()`: the length in UTF-8 bytes. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** `str::to_ascii_lowercase`: only `A`-`Z` change. */
export function asciiLowercase(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** `str::lines`: split at `\n`, drop a `\r` before it, and no empty line after a final
 * line break. */
export function lines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** The order of `String`'s `Ord`: by Unicode scalar value (the UTF-8 byte order), not by
 * UTF-16 code unit as `<` compares. */
export function compareStrings(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done || y.done) return Number(!x.done) - Number(!y.done);
    const difference = (x.value.codePointAt(0) ?? 0) - (y.value.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
}

/** `{:?}` of a string: quoted, with `\0`, `\t`, `\r`, `\n`, `\\`, `\"`, and `\u{...}` for
 * the characters Rust does not print as they are. */
export function debugString(text: string): string {
  let quoted = '"';
  for (const char of text) {
    switch (char) {
      case "\0":
        quoted += "\\0";
        break;
      case "\t":
        quoted += "\\t";
        break;
      case "\r":
        quoted += "\\r";
        break;
      case "\n":
        quoted += "\\n";
        break;
      case "\\":
        quoted += "\\\\";
        break;
      case '"':
        quoted += '\\"';
        break;
      default:
        quoted +=
          char !== " " && ESCAPED_IN_DEBUG.test(char)
            ? `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`
            : char;
    }
  }
  return `${quoted}"`;
}

/** `{}` of an `f64`: the shortest digits that read back as the same value, never in
 * exponent notation, `-0` for negative zero, and `NaN`, `inf`, `-inf`. */
export function displayFloat(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  if (Object.is(value, -0)) return "-0";
  const shortest = String(value);
  const exponent = shortest.indexOf("e");
  if (exponent === -1) return shortest;
  const sign = value < 0 ? "-" : "";
  const mantissa = shortest.slice(sign.length, exponent);
  const power = Number(shortest.slice(exponent + 1));
  const digits = mantissa.replace(".", "");
  const point = (mantissa.indexOf(".") === -1 ? mantissa.length : mantissa.indexOf(".")) + power;
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** `{:0width$}` of an integer: zero padding after the sign, the sign counted in the width. */
export function padNumber(value: number, width: number): string {
  const sign = value < 0 ? "-" : "";
  return sign + String(Math.abs(value)).padStart(width - sign.length, "0");
}

/** `i64::div_euclid`. */
export function divEuclid(value: number, divisor: number): number {
  return Math.floor(value / divisor);
}

/** `i64::rem_euclid`. */
export function remEuclid(value: number, divisor: number): number {
  return value - divEuclid(value, divisor) * divisor;
}
