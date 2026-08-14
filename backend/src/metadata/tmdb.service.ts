import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const TMDB_BASE = 'https://api.themoviedb.org/3';
// w500 balances quality against download time for a whole library; the
// originals are needlessly large for a LAN client.
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

export interface TmdbMatch {
  tmdbId: number;
  name: string;
  overview: string | null;
  releaseYear: number | null;
  posterPath: string | null;
  genres: string[];
}

interface SearchResult {
  id: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
}

@Injectable()
export class TmdbService {
  private readonly logger = new Logger(TmdbService.name);

  constructor(private readonly config: ConfigService) {}

  get isConfigured(): boolean {
    return !!this.config.get<string>('tmdb.accessToken');
  }

  posterUrl(posterPath: string): string {
    return `${IMAGE_BASE}${posterPath}`;
  }

  /** Best-effort match for a movie. Returns null when nothing plausible is found. */
  async searchMovie(name: string, year?: number | null): Promise<TmdbMatch | null> {
    const params = new URLSearchParams({ query: name });
    if (year) params.set('year', String(year));

    const data = await this.get<{ results: SearchResult[] }>('/search/movie', params);
    const hit = data?.results?.[0];
    if (!hit) return null;

    return {
      tmdbId: hit.id,
      name: hit.title ?? name,
      overview: hit.overview || null,
      releaseYear: parseYear(hit.release_date),
      posterPath: hit.poster_path ?? null,
      genres: await this.fetchGenres('movie', hit.id),
    };
  }

  async searchSeries(name: string): Promise<TmdbMatch | null> {
    const params = new URLSearchParams({ query: name });

    const data = await this.get<{ results: SearchResult[] }>('/search/tv', params);
    const hit = data?.results?.[0];
    if (!hit) return null;

    return {
      tmdbId: hit.id,
      name: hit.name ?? name,
      overview: hit.overview || null,
      releaseYear: parseYear(hit.first_air_date),
      posterPath: hit.poster_path ?? null,
      genres: await this.fetchGenres('tv', hit.id),
    };
  }

  /**
   * Certification for the configured country, e.g. "PG" for movies or
   * "TV-14" for series. Movies and series use different endpoints and
   * different response shapes.
   */
  async fetchCertification(kind: 'movie' | 'tv', tmdbId: number): Promise<string | null> {
    const country = this.config.get<string>('tmdb.certificationCountry') ?? 'US';

    if (kind === 'movie') {
      const data = await this.get<{
        results: Array<{ iso_3166_1: string; release_dates: Array<{ certification: string }> }>;
      }>(`/movie/${tmdbId}/release_dates`);

      const entry = data?.results?.find((r) => r.iso_3166_1 === country);
      // TMDB lists one entry per release type (theatrical, digital, ...) and
      // leaves certification empty on most of them.
      const cert = entry?.release_dates?.find((r) => r.certification)?.certification;
      return cert || null;
    }

    const data = await this.get<{ results: Array<{ iso_3166_1: string; rating: string }> }>(
      `/tv/${tmdbId}/content_ratings`,
    );
    const entry = data?.results?.find((r) => r.iso_3166_1 === country);
    return entry?.rating || null;
  }

  /** Downloads a poster, returning its bytes. */
  async downloadPoster(posterPath: string): Promise<Buffer> {
    const response = await fetch(this.posterUrl(posterPath));
    if (!response.ok) {
      throw new Error(`Poster download failed: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private async fetchGenres(kind: 'movie' | 'tv', tmdbId: number): Promise<string[]> {
    const data = await this.get<{ genres?: Array<{ name: string }> }>(`/${kind}/${tmdbId}`);
    return data?.genres?.map((g) => g.name) ?? [];
  }

  private async get<T>(path: string, params?: URLSearchParams): Promise<T | null> {
    const token = this.config.get<string>('tmdb.accessToken');
    if (!token) return null;

    const query = new URLSearchParams(params);
    query.set('language', this.config.get<string>('tmdb.language') ?? 'bg-BG');

    const response = await fetch(`${TMDB_BASE}${path}?${query.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      // One failed lookup should not abort a whole library refresh, so this is
      // logged and treated as "no match" rather than thrown.
      this.logger.warn(`TMDB ${path} returned ${response.status}`);
      return null;
    }

    return (await response.json()) as T;
  }
}

function parseYear(date?: string): number | null {
  if (!date) return null;
  const year = Number(date.slice(0, 4));
  return Number.isInteger(year) ? year : null;
}
