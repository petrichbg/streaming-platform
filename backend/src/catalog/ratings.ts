// Content rating comparison for parental controls.
//
// Two separate ladders (MPAA for movies, TV Parental Guidelines for series)
// because "PG-13" and "TV-14" are not the same scale. Comparison only
// happens within a ladder; a rating from the other ladder is treated as
// unknown rather than silently mapped across, since those mappings are
// approximate and getting them wrong in a parental control is a real harm.

const MOVIE_LADDER = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
const TV_LADDER = ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'];

/**
 * Every value a profile's cap may take.
 *
 * Worth validating against on write: `isRatingAllowed` treats a cap it does
 * not recognise as "no cap at all", so a typo like "pg13" would quietly turn
 * the parental control off rather than fail.
 */
export const ALLOWED_MAX_RATINGS: ReadonlyArray<string> = [...MOVIE_LADDER, ...TV_LADDER];

function normalize(rating: string): string {
  return rating.trim().toUpperCase();
}

function ladderFor(rating: string): string[] | undefined {
  const value = normalize(rating);
  if (MOVIE_LADDER.includes(value)) return MOVIE_LADDER;
  if (TV_LADDER.includes(value)) return TV_LADDER;
  return undefined;
}

/**
 * True if content rated `titleRating` may be shown to a profile capped at
 * `maxRating`.
 *
 * Deliberately fails closed: unrated content (`null`) and ratings we don't
 * recognise are HIDDEN from a restricted profile. Permissive-by-default
 * would mean an unrated file silently reaches a kid profile, which defeats
 * the point. Consequence worth knowing: until real metadata (e.g. TMDB)
 * populates Title.rating, a restricted profile sees an empty catalog.
 *
 * A profile with no maxRating set is unrestricted and sees everything.
 */
export function isRatingAllowed(
  titleRating: string | null | undefined,
  maxRating: string | null | undefined,
): boolean {
  if (!maxRating) return true;

  const maxLadder = ladderFor(maxRating);
  if (!maxLadder) return true; // unrecognised cap — don't silently block everything

  if (!titleRating) return false;

  const titleLadder = ladderFor(titleRating);
  if (!titleLadder || titleLadder !== maxLadder) return false;

  return titleLadder.indexOf(normalize(titleRating)) <= maxLadder.indexOf(normalize(maxRating));
}
