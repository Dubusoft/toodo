/**
 * Display helpers for repository and worktree paths: POSIX paths on the server and on SSH
 * machines, and Windows paths (drive letters and UNC shares).
 */

type Parsed = { root: string; separator: string; segments: string[] };

function parse(path: string): Parsed {
  const windows = /^[a-zA-Z]:/.test(path) || path.startsWith("\\\\") || (path.includes("\\") && !path.includes("/"));
  const separator = windows ? "\\" : "/";
  let root = "";
  let rest = path;
  const unc = windows ? /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.exec(path) : null;
  const drive = windows ? /^[a-zA-Z]:([\\/]?)/.exec(path) : null;
  if (unc) {
    root = `${unc[0].replace(/[\\/]+/g, "\\").replace(/^\\/, "\\\\")}\\`;
    rest = path.slice(unc[0].length);
  } else if (drive) {
    root = drive[0].slice(0, 2) + (drive[1] ? separator : "");
    rest = path.slice(drive[0].length);
  } else if (/^[\\/]/.test(path)) {
    root = separator;
    rest = path.replace(/^[\\/]+/, "");
  }
  const segments: string[] = [];
  for (const segment of rest.split(windows ? /[\\/]+/ : /\/+/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
      else if (root === "") segments.push(segment);
      continue;
    }
    segments.push(segment);
  }
  return { root, separator, segments };
}

/** `path` without `.` and `..` segments or repeated and trailing separators. */
export function normalizePath(path: string): string {
  const { root, separator, segments } = parse(path);
  const joined = root + segments.join(separator);
  return joined === "" ? "." : joined;
}

/**
 * The last `keep` folders of the normalized `path`, led by an ellipsis when earlier folders
 * are left out, e.g. "…/repos/toodo" for "/data/repos/toodo".
 */
export function shortPath(path: string, keep = 2): string {
  const { separator, segments } = parse(path);
  if (segments.length <= keep) return normalizePath(path);
  return `…${separator}${segments.slice(-keep).join(separator)}`;
}
