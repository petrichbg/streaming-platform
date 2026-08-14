'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  api,
  API_URL,
  ApiError,
  clearToken,
  getToken,
  resolveProfile,
  startProfileSession,
  type Profile,
  type ContinueWatchingEntry,
  type TitleDetail,
  type TitleListItem,
} from '@/lib/api';

// Long enough that a typist does not fire a request per keystroke, short
// enough that the grid still feels like it reacts to typing.
const SEARCH_DEBOUNCE_MS = 250;

export default function BrowsePage() {
  const router = useRouter();
  const [titles, setTitles] = useState<TitleListItem[] | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [pendingProfileId, setPendingProfileId] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'MOVIE' | 'SERIES'>('ALL');
  const [genreFilter, setGenreFilter] = useState('');
  const [yearFilter, setYearFilter] = useState('');
  const [searching, setSearching] = useState(false);
  const [continueWatching, setContinueWatching] = useState<ContinueWatchingEntry[]>([]);
  const [featuredDetail, setFeaturedDetail] = useState<TitleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // Profiles load once; the catalog below re-fetches whenever the choice
  // changes, because the rating cap is applied server-side per profile.
  useEffect(() => {
    if (!getToken()) return;

    let cancelled = false;
    (async () => {
      try {
        const list = await api.get<Profile[]>('/profiles');
        if (cancelled) return;
        setProfiles(list);

        const chosen = resolveProfile(list);
        if (!chosen) return;

        // A locked profile has to be unlocked again on a fresh page, so ask
        // rather than silently carrying on with whatever session the previous
        // visit left behind.
        if (chosen.hasPin) {
          if (!cancelled) setPendingProfileId(chosen.id);
          return;
        }

        // Bind the session before the catalog loads, so the very first
        // request already carries the profile's cap.
        await startProfileSession(chosen.id);
        if (!cancelled) setProfileId(chosen.id);
      } catch {
        // Browsing without a bound profile still works -- it just means no
        // rating cap, so this must not block the catalog.
        if (!cancelled) setProfileId(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function switchProfile(id: string) {
    // A locked profile is not entered until the PIN checks out, so nothing
    // about the current view changes yet -- the picker snaps back on its own
    // because it renders from profileId.
    if (profiles.find((p) => p.id === id)?.hasPin) {
      setPendingProfileId(id);
      setPin('');
      setPinError(null);
      return;
    }
    await enterProfile(id);
  }

  async function enterProfile(id: string, pin?: string) {
    try {
      await startProfileSession(id, pin);
      // Cleared only once the switch is certain. Doing it before the request
      // leaves the grid stuck on "loading" when a PIN is refused, because
      // profileId never changes and nothing triggers a refetch.
      setTitles(null);
      setProfileId(id);
      setPendingProfileId(null);
      setPin('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Неуспешна смяна на профил';
      if (pendingProfileId) setPinError(translatePinError(message));
      else setError(message);
    }
  }

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }

    // Guards against a slow early request landing after a faster later one
    // and repainting the grid with results for a query the user has already
    // moved on from.
    let cancelled = false;
    const term = query.trim();

    const params = new URLSearchParams();
    if (term) params.set('search', term);
    // Without profileId the API deliberately browses unrestricted, so the
    // parental cap only takes effect once a profile is actually named.
    if (profileId) params.set('profileId', profileId);
    const queryString = params.toString();

    const timer = setTimeout(() => {
      setSearching(true);
      api
        .get<TitleListItem[]>(`/titles${queryString ? `?${queryString}` : ''}`)
        .then((result) => {
          if (cancelled) return;
          setTitles(result);
          setError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          // An expired or invalid token is the common case here; drop it and
          // send the user back to login rather than showing a dead page.
          if (err instanceof ApiError && err.status === 401) {
            clearToken();
            router.replace('/login');
            return;
          }
          setError(err instanceof Error ? err.message : 'Failed to load titles');
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, profileId, router]);

  useEffect(() => {
    if (!profileId) {
      setContinueWatching([]);
      return;
    }
    let cancelled = false;
    api.get<ContinueWatchingEntry[]>(`/profiles/${profileId}/continue-watching`)
      .then((items) => {
        if (!cancelled) setContinueWatching(items.filter((item) => item.positionSec > 15));
      })
      .catch(() => {
        if (!cancelled) setContinueWatching([]);
      });
    return () => { cancelled = true; };
  }, [profileId]);

  function signOut() {
    clearToken();
    router.replace('/login');
  }

  const term = query.trim();
  const activeProfile = profiles.find((p) => p.id === profileId) ?? null;
  const genres = Array.from(new Set((titles ?? []).flatMap((title) => title.genres))).sort();
  const years = Array.from(new Set((titles ?? []).map((title) => title.releaseYear).filter((year): year is number => Boolean(year)))).sort((a, b) => b - a);
  const filteredTitles = (titles ?? []).filter((title) =>
    (typeFilter === 'ALL' || title.type === typeFilter) &&
    (!genreFilter || title.genres.includes(genreFilter)) &&
    (!yearFilter || title.releaseYear === Number(yearFilter)),
  );
  const featured = [...(titles ?? [])].filter((title) => title.posterPath).sort((a, b) => b.popularity - a.popularity)[0];

  useEffect(() => {
    if (!featured) {
      setFeaturedDetail(null);
      return;
    }
    let cancelled = false;
    api.get<TitleDetail>(`/titles/${featured.id}${profileId ? `?profileId=${profileId}` : ''}`)
      .then((detail) => { if (!cancelled) setFeaturedDetail(detail); })
      .catch(() => { if (!cancelled) setFeaturedDetail(null); });
    return () => { cancelled = true; };
  }, [featured?.id, profileId]);

  return (
    <main className="container-fluid page browse-page" id="main-content">
      <header className="stream-navbar">
        <button
          className="mobile-menu-toggle"
          type="button"
          aria-label="Отвори менюто"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span /><span /><span />
        </button>
        <Link href="/" className="stream-wordmark">STREAM</Link>
        <nav className={`stream-nav-links ${menuOpen ? 'is-open' : ''}`} aria-label="Основна навигация">
          <Link href="/" className="active">Начало</Link>
          <button type="button" onClick={() => setTypeFilter('MOVIE')}>Филми</button>
          <button type="button" onClick={() => setTypeFilter('SERIES')}>Сериали</button>
          <Link href="/my-list">Моят списък</Link>
        </nav>
        <label className="nav-search">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Търсене..."
            aria-label="Търси по заглавие"
          />
          <kbd>⌘ K</kbd>
        </label>
        <details className="profile-menu">
          <summary>
            <span className="profile-mini-avatar">{activeProfile?.name.slice(0, 1).toUpperCase() ?? 'И'}</span>
            <span>{activeProfile?.name ?? 'Профил'}</span>
            <span aria-hidden="true">⌄</span>
          </summary>
          <div className="profile-menu-panel">
            {profiles.length > 1 && (
              <label>
                <span>Смени профил</span>
                <select value={profileId ?? ''} onChange={(event) => switchProfile(event.target.value)}>
                  {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.hasPin ? '🔒 ' : ''}{profile.name}</option>)}
                </select>
              </label>
            )}
            <Link href="/profiles">♙ <span>Моят профил</span></Link>
            <Link href="/my-list">▣ <span>Моят списък</span></Link>
            <Link href="/settings">⚙ <span>Настройки</span></Link>
            <button type="button" onClick={signOut}>↪ <span>Изход</span></button>
          </div>
        </details>
      </header>

      {pendingProfileId && (
        <form
          className="card pin-card shadow-lg"
          style={{ display: 'grid', gap: 8, maxWidth: 320, marginBottom: 16 }}
          onSubmit={(event) => {
            event.preventDefault();
            void enterProfile(pendingProfileId, pin);
          }}
        >
          <div style={{ fontWeight: 600 }}>
            PIN за „{profiles.find((p) => p.id === pendingProfileId)?.name}"
          </div>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            placeholder="••••"
            aria-label="PIN"
          />
          {pinError && <div className="error">{pinError}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={!pin}>
              Влез
            </button>
            <button
              type="button"
              style={{ background: 'transparent' }}
              onClick={() => {
                setPendingProfileId(null);
                setPin('');
                setPinError(null);
              }}
            >
              Отказ
            </button>
          </div>
        </form>
      )}

      {/* A capped profile hides unrated titles as well as over-rated ones
          (see backend ratings.ts), so an unexpectedly short list needs an
          explanation rather than looking like a broken catalog. */}
      {activeProfile?.maxRating && (
        <div className="muted" style={{ marginBottom: 16, fontSize: 14 }}>
          Гледаш като <strong>{activeProfile.name}</strong> · показва се само
          съдържание с рейтинг до {activeProfile.maxRating}; нерейтингваното е скрито.
        </div>
      )}

      {featured && !term && (
        <section className="featured-hero" style={{ backgroundImage: `url(${API_URL}${featured.posterPath})` }}>
          <div className="featured-content">
            <div className="featured-meta">
              <span className="featured-badge">НОВ</span>
              {featured.releaseYear && <span>{featured.releaseYear}</span>}
              {featuredDetail?.mediaFiles[0]?.durationSec && <span>{formatMinutes(featuredDetail.mediaFiles[0].durationSec)}</span>}
              {featured.genres.slice(0, 2).map((genre) => <span key={genre}>{genre}</span>)}
              {featuredDetail?.rating && <span className="rating-chip">{featuredDetail.rating}</span>}
            </div>
            <h2>{featured.name}</h2>
            <p>{featuredDetail?.overview ?? `${featured.genres.slice(0, 3).join(' · ')} от личната ти библиотека.`}</p>
            <div className="featured-actions">
              <button className="btn btn-primary" onClick={() => router.push(`/title/${featured.id}`)}>▶ <span>Гледай сега</span></button>
              <button className="btn btn-outline-light" onClick={() => router.push(`/title/${featured.id}`)}>ⓘ <span>Повече информация</span></button>
            </div>
          </div>
          <div className="hero-pagination" aria-hidden="true"><span className="active"/><span/><span/><span/><span/></div>
        </section>
      )}

      {continueWatching.length > 0 && !term && (
        <section className="continue-section" aria-labelledby="continue-title">
          <div className="section-heading inline-heading"><h2 id="continue-title">Продължи да гледаш</h2><span aria-hidden="true">›</span></div>
          <div className="continue-row">
            {continueWatching.slice(0, 8).map((item) => {
              const title = item.title ?? item.episode?.title;
              const media = item.title?.mediaFiles[0] ?? item.episode?.mediaFiles[0];
              if (!title || !media) return null;
              const percent = item.durationSec
                ? Math.min(100, Math.max(2, (item.positionSec / item.durationSec) * 100))
                : 8;
              return (
                <button
                  className="continue-card"
                  key={item.id}
                  onClick={() => router.push(`/watch/${media.id}`)}
                  aria-label={`Продължи ${title.name}`}
                >
                  <div className="continue-art">
                    {title.posterPath && <img src={`${API_URL}${title.posterPath}`} alt="" />}
                    <span className="continue-play" aria-hidden="true">▶</span>
                    <span className="progress-track"><span style={{ width: `${percent}%` }} /></span>
                  </div>
                  <strong>{title.name}</strong>
                  <span>{item.episode ? `С${item.episode.seasonNumber} Е${item.episode.episodeNumber}` : formatMinutes(item.positionSec)}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section className="catalog-heading">
        <h2>{term ? `Резултати за „${term}“` : 'Популярни в библиотеката'}</h2>
      </section>

      <div className="catalog-filters" aria-label="Филтри">
        <div className="segmented-control">
          {([['ALL','Всички'],['MOVIE','Филми'],['SERIES','Сериали']] as const).map(([value,label]) => <button key={value} className={typeFilter === value ? 'active' : ''} onClick={() => setTypeFilter(value)}>{label}</button>)}
        </div>
        <select className="form-select form-select-sm" aria-label="Жанр" value={genreFilter} onChange={(event) => setGenreFilter(event.target.value)}><option value="">Всички жанрове</option>{genres.map((genre) => <option key={genre}>{genre}</option>)}</select>
        <select className="form-select form-select-sm" aria-label="Година" value={yearFilter} onChange={(event) => setYearFilter(event.target.value)}><option value="">Всички години</option>{years.map((year) => <option key={year}>{year}</option>)}</select>
        {(typeFilter !== 'ALL' || genreFilter || yearFilter) && <button className="clear-filters" onClick={() => {setTypeFilter('ALL');setGenreFilter('');setYearFilter('');}}>Изчисти</button>}
      </div>

      {error && <div className="error">{error}</div>}
      {!titles && !error && (
        <div className="grid" aria-label="Зареждане">
          {Array.from({ length: 8 }).map((_, index) => (
            <div className="poster-skeleton" key={index} />
          ))}
        </div>
      )}

      {titles && term && (
        <div className="muted" style={{ marginBottom: 16, fontSize: 14 }}>
          {titles.length === 0
            ? `Нищо не е намерено за „${term}“`
            : `${titles.length} ${titles.length === 1 ? 'резултат' : 'резултата'} за „${term}“`}
          {searching && ' · търси се...'}
        </div>
      )}

      {/* Only meaningful when nothing is filtered out -- an empty result for a
          search term means the term matched nothing, not an empty library. */}
      {titles?.length === 0 && !term && (
        <div className="empty-state muted">
          Няма заглавия. Пусни <code>POST /media/scan</code> на backend-а, за да
          импортираш библиотеката.
        </div>
      )}

      <div className="grid">
        {filteredTitles.map((title) => (
          <TitleCard key={title.id} title={title} profileId={profileId} />
        ))}
      </div>
    </main>
  );
}

/**
 * The API answers in English; the rest of this interface is in Bulgarian, and
 * a wrong PIN is the one error an ordinary viewer will actually meet.
 */
function translatePinError(message: string): string {
  const lockout = /try again in (\d+)s/i.exec(message);
  if (lockout) {
    return `Твърде много опити. Опитай пак след ${lockout[1]} секунди.`;
  }
  if (/incorrect pin/i.test(message)) return 'Грешен PIN.';
  return message;
}

function TitleCard({ title, profileId }: { title: TitleListItem; profileId: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The catalog list only carries counts, not media file ids, so the first
  // playable file is resolved on click via the detail endpoint.
  async function play() {
    setBusy(true);
    setError(null);
    try {
      // Carries the profile too: the list this card came from could be stale
      // after a profile switch, and the detail endpoint applies the same cap.
      const detail = await api.get<TitleDetail>(
        `/titles/${title.id}${profileId ? `?profileId=${profileId}` : ''}`,
      );
      const mediaFile = detail.mediaFiles[0] ?? detail.episodes[0]?.mediaFiles[0];
      if (!mediaFile) {
        setError('Няма медиен файл');
        return;
      }
      router.push(`/watch/${mediaFile.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Грешка');
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      className="card title-card"
      style={{ display: 'grid', gap: 8 }}
      onClick={() => router.push(`/title/${title.id}`)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') router.push(`/title/${title.id}`);
      }}
      role="link"
      tabIndex={0}
      aria-label={`Отвори ${title.name}`}
    >
      {title.posterPath ? (
        // Plain <img> rather than next/image: the poster endpoint lives on the
        // API origin, which next/image would need allow-listed for no real
        // benefit on a LAN.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`${API_URL}${title.posterPath}`}
          alt={title.name}
          style={{
            width: '100%',
            aspectRatio: '2 / 3',
            objectFit: 'cover',
            borderRadius: 8,
            background: '#000',
          }}
        />
      ) : (
        <div
          className="muted"
          style={{
            aspectRatio: '2 / 3',
            display: 'grid',
            placeItems: 'center',
            borderRadius: 8,
            background: '#0b0d10',
            fontSize: 13,
          }}
        >
          без постер
        </div>
      )}

      <div className="title-name" style={{ fontWeight: 600 }}>{title.name}</div>
      <div className="title-meta muted" style={{ fontSize: 14 }}>
        {title.type === 'SERIES' ? `Сериал · ${title.episodeCount} епизода` : 'Филм'}
        {title.releaseYear ? ` · ${title.releaseYear}` : ''}
      </div>
      {title.genres.length > 0 && (
        <div className="title-genres muted" style={{ fontSize: 13 }}>
          {title.genres.join(', ')}
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <button className="play-button" onClick={(event) => { event.stopPropagation(); void play(); }} disabled={busy}>
        <span aria-hidden="true">▶</span> {busy ? 'Зареждане' : 'Гледай'}
      </button>
    </article>
  );
}

function formatMinutes(seconds: number): string {
  return `${Math.max(1, Math.floor(seconds / 60))} мин. гледани`;
}
