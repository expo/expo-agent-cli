// @ref llp/0028-local-docs.rfc.md §Commands — the ranking of `docs:search`, as pure functions.

/** One page as the cache holds it: the site path and the Markdown of `<path>.md`. */
export interface DocPage {
  path: string;
  content: string;
}

export interface SearchHit {
  path: string;
  title: string;
  heading: string | null;
  /** 1-based line of the file on disk, frontmatter included. */
  line: number;
  snippet: string;
}

const WEIGHT = { title: 8, slug: 4, heading: 2, body: 1 } as const;
const SNIPPET_LENGTH = 160;

interface ParsedPage {
  path: string;
  title: string;
  slug: string;
  /** Lines after the frontmatter, with their 1-based line numbers in the file. */
  body: { number: number; text: string; heading: boolean }[];
}

/** `sdk/camera` for `versions/v57.0.0/sdk/camera`: the part of the path that names the page. */
function slugOf(pagePath: string): string {
  return pagePath.replace(/^versions\/[^/]+\//, '');
}

function frontmatterTitle(lines: string[]): string | null {
  for (const line of lines) {
    const match = /^title:\s*(.+?)\s*$/.exec(line);
    if (match) {
      return match[1]!.replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return null;
}

export function parsePage(page: DocPage): ParsedPage {
  const lines = page.content.split('\n');
  let bodyStart = 0;
  let frontmatter: string[] = [];
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end > 0) {
      frontmatter = lines.slice(1, end);
      bodyStart = end + 1;
    }
  }
  let fence: string | null = null;
  const body = lines.slice(bodyStart).map((text, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(text)?.[1];
    if (marker && (fence == null || marker.startsWith(fence))) {
      fence = fence == null ? marker : null;
      return { number: bodyStart + index + 1, text, heading: false };
    }
    return {
      number: bodyStart + index + 1,
      text,
      heading: fence == null && /^#{1,6}\s/.test(text),
    };
  });
  const h1 = body.find((line) => line.heading && /^#\s/.test(line.text))?.text.replace(/^#\s+/, '');
  return {
    path: page.path,
    title: frontmatterTitle(frontmatter) ?? h1?.trim() ?? page.path,
    slug: slugOf(page.path),
    body,
  };
}

/** The nearest `##` or `###` at or above one body line. */
function headingAt(page: ParsedPage, lineIndex: number): string | null {
  for (let index = lineIndex; index >= 0; index--) {
    const line = page.body[index]!;
    const match = line.heading ? /^#{2,3}\s+(.+?)\s*#*\s*$/.exec(line.text) : null;
    if (match) {
      return match[1]!;
    }
  }
  return null;
}

function snippetOf(text: string, matchIndex: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= SNIPPET_LENGTH) {
    return trimmed;
  }
  const offset = text.length - text.trimStart().length;
  const start = Math.max(0, matchIndex - offset - SNIPPET_LENGTH / 4);
  const piece = trimmed.slice(start, start + SNIPPET_LENGTH);
  return `${start > 0 ? '…' : ''}${piece}${start + SNIPPET_LENGTH < trimmed.length ? '…' : ''}`;
}

export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
}

function hitAt(page: ParsedPage, lineIndex: number, matchIndex: number): SearchHit {
  const line = page.body[lineIndex];
  return {
    path: page.path,
    title: page.title,
    heading: line ? headingAt(page, lineIndex) : null,
    line: line?.number ?? 1,
    snippet: line ? snippetOf(line.text, matchIndex) : '',
  };
}

/**
 * Pages that hold every term, best first.
 *
 * A term scores the highest weight of the places it is in: title, path slug, headings, body. Body
 * occurrences add a little on top, so a page about a term outranks one that names it once.
 */
export function searchTerms(pages: DocPage[], query: string, limit: number): SearchHit[] {
  const terms = queryTerms(query);
  if (!terms.length) {
    return [];
  }

  const scored: { hit: SearchHit; score: number }[] = [];
  for (const source of pages) {
    const page = parsePage(source);
    const title = page.title.toLowerCase();
    const slug = page.slug.toLowerCase();
    const lowered = page.body.map((line) => line.text.toLowerCase());

    let score = 0;
    let everyTerm = true;
    for (const term of terms) {
      let best = 0;
      let occurrences = 0;
      if (title.includes(term)) best = WEIGHT.title;
      else if (slug.includes(term)) best = WEIGHT.slug;
      lowered.forEach((text, index) => {
        if (text.includes(term)) {
          occurrences++;
          best = Math.max(best, page.body[index]!.heading ? WEIGHT.heading : WEIGHT.body);
        }
      });
      if (!best) {
        everyTerm = false;
        break;
      }
      score += best + Math.min(occurrences, 10) / 10;
    }
    if (!everyTerm) {
      continue;
    }

    let bestLine = -1;
    let bestLineWeight = 0;
    let bestLineTerms = 0;
    let matchIndex = 0;
    lowered.forEach((text, index) => {
      const matched = terms.filter((term) => text.includes(term));
      if (!matched.length) {
        return;
      }
      const weight = page.body[index]!.heading ? WEIGHT.heading : WEIGHT.body;
      if (
        weight > bestLineWeight ||
        (weight === bestLineWeight && matched.length > bestLineTerms)
      ) {
        bestLine = index;
        bestLineWeight = weight;
        bestLineTerms = matched.length;
        matchIndex = text.indexOf(matched[0]!);
      }
    });
    const firstText = page.body.findIndex((line) => line.text.trim());
    scored.push({
      hit: hitAt(page, bestLine >= 0 ? bestLine : firstText, matchIndex),
      score,
    });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.hit.path.localeCompare(b.hit.path))
    .slice(0, limit)
    .map(({ hit }) => hit);
}

/** Every body line the pattern matches, by path, then line. */
export function searchRegex(pages: DocPage[], pattern: RegExp, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const sorted = [...pages].sort((a, b) => a.path.localeCompare(b.path));
  for (const source of sorted) {
    const page = parsePage(source);
    for (let index = 0; index < page.body.length; index++) {
      const match = pattern.exec(page.body[index]!.text);
      if (match) {
        hits.push(hitAt(page, index, match.index));
        if (hits.length >= limit) {
          return hits;
        }
      }
    }
  }
  return hits;
}
