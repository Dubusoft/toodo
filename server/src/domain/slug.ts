// Slugs used in worktree directory names and branch names.
//
// A slug contains only lowercase ASCII letters, digits, and single inner hyphens, so it is
// valid as a Windows directory name, a POSIX directory name, and a git ref component. Other
// characters (including non-ASCII letters) act as word separators.

const MAX_SLUG_LEN = 48;

const WINDOWS_RESERVED_NAMES: readonly string[] = [
  "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
  "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/** Converts `input` to a slug. Returns `fallback` when nothing usable remains, and appends
 * `-<fallback>` to Windows reserved device names such as `con`. */
export function slugify(input: string, fallback: string): string {
  const joined = asciiWords(input).join("-");
  const slug =
    joined.length > MAX_SLUG_LEN ? joined.slice(0, MAX_SLUG_LEN).replace(/-+$/, "") : joined;
  if (slug === "") return fallback;
  if (WINDOWS_RESERVED_NAMES.includes(slug)) return `${slug}-${fallback}`;
  return slug;
}

/** The runs of ASCII letters and digits of `input`, lowercased. */
function asciiWords(input: string): string[] {
  return (input.match(/[A-Za-z0-9]+/g) ?? []).map((word) => word.toLowerCase());
}
