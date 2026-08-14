// Heuristic parser turning a path under MEDIA_ROOT into a title. Good enough
// for an import pass; TMDB does the real identification afterwards, and the
// point of the heuristics is to hand it something it can match.

export interface ParsedFilename {
  type: 'movie' | 'episode';
  title: string;
  year?: number;
  season?: number;
  episode?: number;
}

const EPISODE_RE = /^(.*?)[.\s_-]+[Ss](\d{1,2})[Ee](\d{1,2})/;
const YEAR_RE = /[.\s_(\[]((19|20)\d{2})([.\s_)\]]|$)/;

// Scene-release sample clips (e.g. "sample.mkv", "Movie.Title.sample.mkv")
// are not the actual title and must not be imported as one. "sample" as a
// standalone token (not part of a longer word) is the near-universal
// convention for these.
const SAMPLE_RE = /(^|[._\s-])sample([._\s-]|$)/i;

// Release tags some groups bolt onto the front, e.g.
// "[ New Year Chibi-BG ] Zootopia.2.2025...". Left in place they become part
// of the title and TMDB matches nothing.
const LEADING_TAG_RE = /^\s*[[(][^\])]*[\])]\s*/;

/**
 * True if this path is a scene-release sample rather than real content.
 *
 * Every segment is checked, not just the file name: releases often put the
 * clip in a `Sample/` directory and give it the same cryptic name as the
 * feature, which is how a 129-second clip ended up in the catalogue as a
 * film in its own right.
 */
export function isSamplePath(relativePath: string): boolean {
  return splitPath(relativePath).some((segment) => SAMPLE_RE.test(stripExtension(segment)));
}

/**
 * Parses the whole relative path rather than just the file name.
 *
 * Release groups routinely name the file after themselves -- `war-potc1.mkv`,
 * `rflx-cacw-bg.mkv`, `whtgcas.mkv` -- while the directory carries the real
 * title. Reading only the file name produced titles no metadata provider
 * could match, so the directory is used when it is demonstrably the more
 * informative of the two.
 */
export function parseMediaPath(relativePath: string): ParsedFilename {
  const segments = splitPath(relativePath);
  const baseName = stripExtension(segments[segments.length - 1]);
  const fromFile = parseFilename(baseName);

  // An SxxExx file name identifies itself; nothing in the path beats that.
  if (fromFile.type === 'episode') return fromFile;

  // A year is the strongest signal that a name is a real release title. When
  // the file has none but a directory does, the directory is the better
  // source -- the file is almost always an abbreviation of it.
  if (fromFile.year === undefined) {
    for (let i = segments.length - 2; i >= 0; i--) {
      const fromDir = parseFilename(segments[i]);
      if (fromDir.year !== undefined) return fromDir;
    }
  }

  return fromFile;
}

export function parseFilename(baseName: string): ParsedFilename {
  const cleaned = baseName.replace(LEADING_TAG_RE, '');

  const episodeMatch = cleaned.match(EPISODE_RE);
  if (episodeMatch) {
    return {
      type: 'episode',
      title: cleanTitle(episodeMatch[1]),
      season: parseInt(episodeMatch[2], 10),
      episode: parseInt(episodeMatch[3], 10),
    };
  }

  const yearMatch = cleaned.match(YEAR_RE);
  const titlePart = yearMatch ? cleaned.slice(0, yearMatch.index) : cleaned;

  return {
    type: 'movie',
    title: cleanTitle(titlePart),
    year: yearMatch ? parseInt(yearMatch[1], 10) : undefined,
  };
}

/** Kept for callers that only have a file name; prefer parseMediaPath. */
export function isSampleClip(baseName: string): boolean {
  return SAMPLE_RE.test(baseName);
}

function splitPath(relativePath: string): string[] {
  return relativePath.split(/[\\/]/).filter(Boolean);
}

function stripExtension(segment: string): string {
  return segment.replace(/\.[^.]+$/, '');
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Cutting the year out of "Some Title - BG Audio - 1989" leaves a dangling
    // separator behind; a title should not end in punctuation.
    .replace(/[\s\-–—:,]+$/, '')
    .trim();
}
