// Thin client for the NestJS API. Everything except /auth/login and
// /auth/register requires a bearer token.

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

const TOKEN_KEY = 'streaming_token';
const PROFILE_KEY = 'streaming_profile';

export function getToken(): string | null {
  // Guarded because Next renders components on the server too, where there
  // is no localStorage.
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  // The profile belongs to the account being signed out of; leaving it would
  // hand the next account a profile id it does not own, and every request
  // carrying it would 404.
  window.localStorage.removeItem(PROFILE_KEY);
}

/**
 * Which profile the viewer is browsing and watching as. Kept next to the
 * token because both are per-device choices that must survive a reload, and
 * because watch progress is keyed on the profile — reading the wrong one
 * silently writes one viewer's resume position over another's.
 */
export function getSelectedProfileId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(PROFILE_KEY);
}

export function setSelectedProfileId(profileId: string): void {
  window.localStorage.setItem(PROFILE_KEY, profileId);
}

/**
 * Binds the session to a profile and stores the token that comes back.
 *
 * The parental-control cap lives in the token, not in a query parameter, so
 * switching profile means exchanging the token -- see the backend's
 * ContentAccessService. Every later request, including the `?token=` on a
 * <video src> and the HLS segment fetches, then carries the cap on its own.
 */
export async function startProfileSession(profileId: string, pin?: string): Promise<Profile> {
  const result = await api.post<{ accessToken: string; profile: Profile }>(
    `/profiles/${profileId}/session`,
    pin ? { pin } : {},
  );
  setToken(result.accessToken);
  setSelectedProfileId(profileId);
  return result.profile;
}

/**
 * Resolves the stored choice against the profiles that actually exist, since
 * a profile can be deleted from another device. Falls back to the first one
 * and re-persists, so the caller never has to deal with a dangling id.
 */
export function resolveProfile(profiles: Profile[]): Profile | null {
  if (profiles.length === 0) return null;

  const stored = getSelectedProfileId();
  const match = profiles.find((p) => p.id === stored);
  const chosen = match ?? profiles[0];

  if (chosen.id !== stored) setSelectedProfileId(chosen.id);
  return chosen;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(`${API_URL}${path}`, { ...init, headers });

  if (!response.ok) {
    // The API returns { message, error, statusCode }; fall back to the raw
    // status if the body is not JSON (e.g. a proxy error page).
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (body?.message) message = String(body.message);
    } catch {
      /* keep the fallback */
    }
    throw new ApiError(message, response.status);
  }

  // Not every success carries a body. A Nest handler returning void answers
  // 200 with nothing at all, and calling .json() on that throws "Unexpected
  // end of JSON input" -- which surfaced as a delete that worked on the server
  // while the page insisted it had failed.
  const body = await response.text();
  if (!body) return undefined as T;
  return JSON.parse(body) as T;
}

async function upload<T>(path: string, form: FormData): Promise<T> {
  const token = getToken();
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${API_URL}${path}`, { method: 'POST', headers, body: form });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { const body = await response.json(); if (body?.message) message = String(body.message); } catch { /* keep fallback */ }
    throw new ApiError(message, response.status);
  }
  return response.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload,
};

// ---------------------------------------------------------------- API types

export interface AuthResult {
  accessToken: string;
  user: { id: string; email: string; isAdmin: boolean };
}

export interface TitleListItem {
  id: string;
  type: 'MOVIE' | 'SERIES';
  name: string;
  releaseYear: number | null;
  genres: string[];
  posterPath: string | null;
  backdropPath: string | null;
  episodeCount: number;
  mediaFileCount: number;
  createdAt: string;
  popularity: number;
}

export interface MediaFile {
  id: string;
  sourcePath: string;
  container: string | null;
  videoCodec: string | null;
  durationSec: number | null;
  quality: string | null;
  audioLanguages: string[];
  subtitleLanguages: string[];
  hdrFormat: string | null;
}

export interface TitleDetail extends Omit<TitleListItem, 'episodeCount' | 'mediaFileCount'> {
  overview: string | null;
  rating: string | null;
  cast: string[];
  director: string | null;
  trailerKey: string | null;
  mediaFiles: MediaFile[];
  episodes: Array<{
    id: string;
    seasonNumber: number;
    episodeNumber: number;
    name: string | null;
    overview: string | null;
    stillPath: string | null;
    mediaFiles: MediaFile[];
  }>;
  related: TitleListItem[];
}

export interface Rendition {
  height: number;
  playlistUrl: string;
}

export interface Profile {
  id: string;
  name: string;
  isKid: boolean;
  maxRating: string | null;
  /** Whether entering this profile requires a PIN. The hash never leaves the API. */
  hasPin?: boolean;
}

/** What the player is actually playing -- progress is keyed on these ids. */
export interface MediaFileInfo {
  id: string;
  titleId: string | null;
  episodeId: string | null;
  durationSec: number | null;
}

export interface WatchProgressEntry {
  id: string;
  titleId: string | null;
  episodeId: string | null;
  positionSec: number;
  durationSec: number | null;
}

export interface ContinueWatchingEntry extends WatchProgressEntry {
  title: (TitleListItem & { mediaFiles: MediaFile[] }) | null;
  episode: ({
    id: string;
    seasonNumber: number;
    episodeNumber: number;
    name: string | null;
    mediaFiles: MediaFile[];
    title: TitleListItem;
  }) | null;
}

export interface PlaybackPlan {
  /** "unavailable" means a transcode is required but none exists yet. */
  mode: 'direct' | 'hls' | 'unavailable';
  url: string | null;
  reason: string;
}

export interface SubtitleTrackInfo {
  index: number;
  codec: string | null;
  language: string | null;
  forced?: boolean;
  /** False for bitmap formats (PGS/VobSub) that cannot become WebVTT. */
  convertible: boolean;
  bitmap?: boolean;
  bitmapHandling?: 'none' | 'burn-in';
  source?: 'embedded' | 'external';
  fileName?: string;
  encoding?: 'utf-8' | 'windows-1251';
  matchConfidence?: number;
}
