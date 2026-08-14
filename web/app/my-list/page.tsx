'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { API_URL, api, getSelectedProfileId, getToken } from '@/lib/api';

interface WatchlistItem {
  id: string;
  titleId: string;
  title: { id: string; name: string; type: 'MOVIE' | 'SERIES'; releaseYear: number | null; genres: string[]; posterPath: string | null };
}

export default function MyListPage() {
  const router = useRouter();
  const [items, setItems] = useState<WatchlistItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const profileId = getSelectedProfileId();

  useEffect(() => {
    if (!getToken()) { router.replace('/login'); return; }
    if (!profileId) { router.replace('/select-profile'); return; }
    api.get<WatchlistItem[]>(`/profiles/${profileId}/watchlist`).then(setItems).catch((err) => setError(err instanceof Error ? err.message : 'Списъкът не може да се зареди.'));
  }, [profileId, router]);

  async function remove(titleId: string) {
    if (!profileId) return;
    await api.delete(`/profiles/${profileId}/watchlist/${titleId}`);
    setItems((current) => current?.filter((item) => item.titleId !== titleId) ?? []);
  }

  return <main className="page collection-page" id="main-content">
    <header className="collection-header"><div><span className="eyebrow">Запазено за по-късно</span><h1>Моят списък</h1></div><Link className="back-link" href="/">← Библиотека</Link></header>
    {error && <div className="error">{error}</div>}
    {!items && !error && <div className="grid">{[0,1,2,3,4].map((n) => <div className="poster-skeleton" key={n}/>)}</div>}
    {items?.length === 0 && <div className="empty-state"><div><h2>Списъкът е празен</h2><p className="muted">Добавяй заглавия от техните detail страници.</p><Link className="button-link" href="/">Разгледай библиотеката</Link></div></div>}
    <div className="grid">{items?.map(({title}) => <article className="saved-card" key={title.id}>
      <button className="saved-open" onClick={() => router.push(`/title/${title.id}`)}>{title.posterPath ? <img src={`${API_URL}${title.posterPath}`} alt={title.name}/> : <span>Без постер</span>}</button>
      <div><strong>{title.name}</strong><span className="muted">{title.type === 'SERIES' ? 'Сериал' : 'Филм'}{title.releaseYear ? ` · ${title.releaseYear}` : ''}</span></div>
      <button className="remove-button" onClick={() => void remove(title.id)} aria-label={`Премахни ${title.name}`}>×</button>
    </article>)}</div>
  </main>;
}
