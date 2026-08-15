import { describe, expect, it } from 'vitest';
import { ALLOWED_MAX_RATINGS, isRatingAllowed } from '../../src/catalog/ratings';

describe('parental rating permissions', () => {
  it('allows everything for an unrestricted profile', () => expect(isRatingAllowed(null, null)).toBe(true));
  it('fails closed for unrated content on a restricted profile', () => expect(isRatingAllowed(null, 'PG-13')).toBe(false));
  it('allows content at or below the cap and rejects above it', () => {
    expect(isRatingAllowed('PG', 'PG-13')).toBe(true);
    expect(isRatingAllowed('PG-13', 'PG-13')).toBe(true);
    expect(isRatingAllowed('R', 'PG-13')).toBe(false);
  });
  it('never compares ratings across movie and TV ladders', () => expect(isRatingAllowed('TV-PG', 'PG-13')).toBe(false));
  it('exposes only valid caps', () => expect(ALLOWED_MAX_RATINGS).toContain('TV-MA'));
});
