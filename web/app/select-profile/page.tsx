'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, api, clearToken, getToken, startProfileSession, type Profile } from '@/lib/api';

export default function SelectProfilePage() {
  const router = useRouter();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [pending, setPending] = useState<Profile | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) { router.replace('/login'); return; }
    api.get<Profile[]>('/profiles').then(setProfiles).catch((err) => {
      if (err instanceof ApiError && err.status === 401) { clearToken(); router.replace('/login'); return; }
      setError(err instanceof Error ? err.message : 'Профилите не могат да се заредят.');
    });
  }, [router]);

  async function choose(profile: Profile, profilePin?: string) {
    if (profile.hasPin && profilePin === undefined) { setPending(profile); return; }
    try {
      await startProfileSession(profile.id, profilePin);
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Профилът не може да се отвори.');
    }
  }

  return (
    <main className="picker-page" id="main-content">
      <div className="picker-heading"><span className="eyebrow">Кино у дома</span><h1>Кой гледа?</h1><p className="muted">Историята, списъкът и ограниченията са различни за всеки профил.</p></div>
      {!profiles && !error && <div className="profile-picker-grid">{[0,1,2].map((n) => <div className="profile-choice skeleton" key={n} />)}</div>}
      {profiles && profiles.length > 0 && <div className="profile-picker-grid">{profiles.map((profile, index) => (
        <button className="profile-choice" key={profile.id} onClick={() => void choose(profile)}>
          <span className={`profile-avatar avatar-${index % 5}`}>{profile.name.slice(0, 1).toUpperCase()}</span>
          <strong>{profile.name}</strong><span>{profile.isKid ? 'Детски профил' : profile.maxRating ? `до ${profile.maxRating}` : 'Без ограничение'}</span>
          {profile.hasPin && <small>Заключен с PIN</small>}
        </button>
      ))}</div>}
      {profiles?.length === 0 && <div className="empty-state"><p>Все още няма профил.</p><Link className="button-link" href="/profiles">Създай профил</Link></div>}
      {pending && <form className="picker-pin card" onSubmit={(event) => { event.preventDefault(); void choose(pending, pin); }}><strong>PIN за {pending.name}</strong><input autoFocus type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} aria-label="PIN" placeholder="••••"/><div><button disabled={!pin}>Продължи</button><button type="button" className="ghost-button" onClick={() => {setPending(null);setPin('');}}>Отказ</button></div></form>}
      {error && <div className="error picker-error">{error}</div>}
      <Link href="/profiles" className="muted picker-manage">Управление на профили</Link>
    </main>
  );
}
