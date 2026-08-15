'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  API_URL,
  ApiError,
  api,
  clearToken,
  getSelectedProfileId,
  getToken,
  type MediaFile,
  type TitleDetail,
} from '@/lib/api';

export default function TitlePage() {
  const { titleId } = useParams<{ titleId: string }>();
  const router = useRouter();
  const [title, setTitle] = useState<TitleDetail | null>(null);
  const [inWatchlist, setInWatchlist] = useState(false);
  const [busy, setBusy] = useState(false);
  const [season, setSeason] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const profileId = getSelectedProfileId();

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    let cancelled = false;
    const suffix = profileId ? `?profileId=${encodeURIComponent(profileId)}` : '';
    Promise.all([
      api.get<TitleDetail>(`/titles/${titleId}${suffix}`),
      profileId ? api.get<Array<{ titleId: string }>>(`/profiles/${profileId}/watchlist`) : [],
    ]).then(([detail, watchlist]) => {
      if (cancelled) return;
      setTitle(detail);
      setInWatchlist(Array.isArray(watchlist) && watchlist.some((item) => item.titleId === titleId));
    }).catch((err) => {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        router.replace('/login');
        return;
      }
      setError(err instanceof Error ? err.message : 'Заглавието не може да се зареди.');
    });
    return () => { cancelled = true; };
  }, [profileId, router, titleId]);

  const firstMedia = useMemo(
    () => title?.mediaFiles[0] ?? title?.episodes[0]?.mediaFiles[0] ?? null,
    [title],
  );
  const seasons = useMemo(() => Array.from(new Set(title?.episodes.map((episode) => episode.seasonNumber) ?? [])).sort((a, b) => a - b), [title]);
  const activeSeason = season ?? seasons[0] ?? null;
  const visibleEpisodes = title?.episodes.filter((episode) => activeSeason === null || episode.seasonNumber === activeSeason) ?? [];

  async function toggleWatchlist() {
    if (!profileId) return;
    setBusy(true);
    try {
      if (inWatchlist) await api.delete(`/profiles/${profileId}/watchlist/${titleId}`);
      else await api.post(`/profiles/${profileId}/watchlist`, { titleId });
      setInWatchlist(!inWatchlist);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Списъкът не може да се обнови.');
    } finally {
      setBusy(false);
    }
  }

  if (error && !title) {
    return <main className="page detail-state"><Link href="/">← Библиотека</Link><h1>Няма достъп</h1><p className="error">{error}</p></main>;
  }
  if (!title) {
    return <main className="page detail-state" aria-busy="true" aria-label="Зареждане на заглавието"><div className="detail-skeleton"><span className="detail-skeleton-poster" /><span className="detail-skeleton-copy"><i /><i /><i /><i /></span></div></main>;
  }

  return (
    <main className="detail-page" id="main-content">
      <div className="detail-backdrop" style={title.backdropPath ? { backgroundImage: `url(${API_URL}${title.backdropPath})` } : undefined} />
      <nav className="detail-nav"><Link href="/">← Библиотека</Link><span className="eyebrow">Кино у дома</span></nav>
      <section className="detail-hero">
        <div className="detail-poster">
          {title.posterPath ? <img src={`${API_URL}${title.posterPath}`} alt={`Постер на ${title.name}`} /> : <div>Без постер</div>}
        </div>
        <div className="detail-copy">
          <span className="eyebrow">{title.type === 'SERIES' ? 'Сериал' : 'Филм'}</span>
          <h1>{title.name}</h1>
          <div className="detail-facts">
            {title.releaseYear && <span>{title.releaseYear}</span>}
            {title.rating && <span className="rating-chip">{title.rating}</span>}
            {title.genres.map((genre) => <span key={genre}>{genre}</span>)}
          </div>
          {title.overview && <p>{title.overview}</p>}
          {(title.director || title.cast.length > 0) && <dl className="title-credits">
            {title.director && <><dt>Режисьор</dt><dd>{title.director}</dd></>}
            {title.cast.length > 0 && <><dt>В ролите</dt><dd>{title.cast.slice(0, 7).join(', ')}</dd></>}
          </dl>}
          <MediaBadges media={firstMedia} />
          <div className="detail-actions">
            <button disabled={!firstMedia} onClick={() => firstMedia && router.push(`/watch/${firstMedia.id}`)}><span aria-hidden="true">▶</span> Гледай</button>
            {profileId && <button className="btn btn-outline-light btn-lg secondary-button" disabled={busy} onClick={toggleWatchlist}>{inWatchlist ? '✓ В моя списък' : '+ Моят списък'}</button>}
            {title.trailerKey && <a className="btn btn-outline-light btn-lg secondary-button" href={`https://www.youtube.com/watch?v=${title.trailerKey}`} target="_blank" rel="noreferrer">Трейлър ↗</a>}
          </div>
          {error && <div className="alert alert-danger">{error}</div>}
        </div>
      </section>

      {title.episodes.length > 0 && (
        <section className="episodes-section">
          <div className="section-heading"><span className="eyebrow">Всички епизоди</span><h2>Сезони и епизоди</h2></div>
          {seasons.length > 1 && <div className="season-tabs" role="tablist" aria-label="Сезони">{seasons.map((number) => <button role="tab" aria-selected={activeSeason === number} className={activeSeason === number ? 'active' : ''} key={number} onClick={() => setSeason(number)}>Сезон {number}</button>)}</div>}
          <div className="episode-list">
            {visibleEpisodes.map((episode) => <EpisodeRow key={episode.id} episode={episode} onPlay={(media) => router.push(`/watch/${media.id}`)} />)}
          </div>
        </section>
      )}
      {title.related.length > 0 && <section className="related-section"><div className="section-heading"><span className="eyebrow">Подбрано за теб</span><h2>Свързани заглавия</h2></div><div className="related-grid">{title.related.map((item) => <Link href={`/title/${item.id}`} key={item.id} className="related-card">{item.posterPath ? <img src={`${API_URL}${item.posterPath}`} alt="" /> : <span />}<strong>{item.name}</strong><small>{item.releaseYear ? `${item.releaseYear} · ` : ''}{item.type === 'SERIES' ? 'Сериал' : 'Филм'}</small></Link>)}</div></section>}
    </main>
  );
}

function EpisodeRow({ episode, onPlay }: { episode: TitleDetail['episodes'][number]; onPlay: (media: MediaFile) => void }) {
  const media = episode.mediaFiles[0];
  return (
    <article className="episode-row">
      <span className="episode-number">С{episode.seasonNumber}<br />Е{episode.episodeNumber}</span>
      <div className="episode-thumbnail">{episode.stillPath ? <img src={`${API_URL}${episode.stillPath}`} alt="" /> : titlePreview(media)}</div>
      <div><strong>{episode.name || `Епизод ${episode.episodeNumber}`}</strong><span>{media?.durationSec ? `${Math.round(media.durationSec / 60)} мин.` : 'Продължителност неизвестна'}</span>{episode.overview && <p>{episode.overview}</p>}<MediaBadges media={media} /></div>
      <button className="btn btn-outline-light secondary-button" disabled={!media} onClick={() => media && onPlay(media)}>▶</button>
    </article>
  );
}

function titlePreview(media?: MediaFile) {
  return media ? <img src={`${API_URL}/stream/${media.id}/preview/thumb_00001.jpg?token=${encodeURIComponent(getToken() ?? '')}`} alt="" onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : <span />;
}

function MediaBadges({ media }: { media?: MediaFile | null }) {
  if (!media) return null;
  const audio = media.audioLanguages.length;
  const subtitles = media.subtitleLanguages.length;
  return <div className="media-badges">
    {media.quality && <span>{media.quality}</span>}
    {media.hdrFormat && <span>{media.hdrFormat}</span>}
    {audio > 0 && <span>{audio} аудио</span>}
    {subtitles > 0 && <span>{subtitles} субтитри</span>}
  </div>;
}
