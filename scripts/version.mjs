// Version arithmetic for scripts/bump-version.mjs, kept apart from its file I/O so tests
// can import it.

export const usage = "Usage: npm run bump <major|minor|patch|X.Y.Z>, or npm run check-version";

const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;

export function nextVersion(current, request) {
  const parts = versionPattern.exec(current);
  if (!parts) throw new Error(`Current version ${current} is not X.Y.Z`);
  const [major, minor, patch] = parts.slice(1).map(Number);
  switch (request) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      if (!versionPattern.test(request)) throw new Error(usage);
      return request;
  }
}

// Replaces the first `count` matches of `pattern` in `text`, each of which must hold
// `current` in its second group, so a layout change fails instead of being skipped.
export function replaceVersion(text, { path, pattern, count }, current, next) {
  let from = 0;
  for (let i = 0; i < count; i++) {
    const match = pattern.exec(text.slice(from));
    if (!match || match[2] !== current) {
      throw new Error(`${path}: expected version ${current} (occurrence ${i + 1} of ${count})`);
    }
    const start = from + match.index;
    const replacement = match[1] + next + match[3];
    text = text.slice(0, start) + replacement + text.slice(start + match[0].length);
    from = start + replacement.length;
  }
  return text;
}
