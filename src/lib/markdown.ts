const fence = /^\s*(```|~~~)/;
const rule = /^\s*([-*_])(\s*\1){2,}\s*$/;
const tableSeparator = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const blockMarkers = /^\s*(>\s*)*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?(\[[ xX]\]\s+)?/;

function inline(text: string): string {
  return (
    text
      // Link targets may hold one level of parentheses, e.g. javascript:alert(1).
      .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
      .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
      .replace(/`+/g, "")
      // Only paired emphasis markers, leaving snake_case, __init__-like names, and a * b alone.
      .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2")
      .replace(/(?<![\w*])([*_])(?=[^\s*_])(.+?)(?<=[^\s*_])\1(?![\w*])/g, "$2")
      .replace(/\s*\|\s*/g, " ")
  );
}

const heading = /^\s*#{1,6}(\s|$)/;

/**
 * The first paragraph of a Markdown description as preview text: headings are skipped rather
 * than run into the text, so a description written as `## Purpose` followed by a paragraph
 * previews that paragraph. Fenced code blocks are skipped too.
 */
export function firstParagraph(source: string): string {
  const paragraph: string[] = [];
  let inFence = false;
  for (const line of source.split(/\r?\n/)) {
    if (fence.test(line)) {
      inFence = !inFence;
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    if (inFence) {
      continue;
    }
    const ends = line.trim() === "" || heading.test(line) || rule.test(line);
    if (ends) {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    paragraph.push(line);
  }
  return markdownPreview(paragraph.join("\n"));
}

/** The text of a Markdown description without its syntax, on one line. */
export function markdownPreview(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => !fence.test(line) && !rule.test(line) && !tableSeparator.test(line))
    .map((line) => inline(line.replace(blockMarkers, "")))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
