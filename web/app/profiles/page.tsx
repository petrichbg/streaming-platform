'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  clearToken,
  getSelectedProfileId,
  getToken,
  type Profile,
} from '@/lib/api';

// Mirrors the ladders in the backend's catalog/ratings.ts. Ratings are only
// comparable within a ladder, so a profile capped at a movie rating sees no
// series at all and vice versa -- which is worth saying out loud in the UI
// rather than letting it look like a bug.
const RATING_GROUPS: ReadonlyArray<{ label: string; ratings: string[] }> = [
  { label: 'Филми (MPAA)', ratings: ['G', 'PG', 'PG-13', 'R', 'NC-17'] },
  { label: 'Сериали (TV)', ratings: ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'] },
];

export default function ProfilesPage() {
  const router = useRouter();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProfiles(await api.get<Profile[]>('/profiles'));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        router.replace('/login');
        return;
      }
      setError(err instanceof Error ? err.message : 'Грешка при зареждане');
    }
  }, [router]);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    void load();
  }, [load, router]);

  // Managing profiles needs a session that is not itself restricted, which the
  // API enforces. Reflecting it here means the buttons are not offered only to
  // fail with a 403.
  const current = profiles?.find((p) => p.id === getSelectedProfileId());
  const restricted = Boolean(current?.maxRating);

  return (
    <main className="page profiles-page" id="main-content">
      <header
        className="profiles-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 24,
        }}
      >
        <div className="brand-block">
          <span className="eyebrow">Кой гледа?</span>
          <h1 style={{ margin: 0 }}>Профили</h1>
        </div>
        <Link href="/" className="back-link muted">
          &larr; Към библиотеката
        </Link>
      </header>

      {error && <div className="error" style={{ marginBottom: 16 }}>{error}</div>}
      {!profiles && !error && <div className="muted">Зареждане...</div>}

      {restricted && (
        <div className="card" style={{ marginBottom: 16 }}>
          Гледаш като <strong>{current?.name}</strong>, който е ограничен профил и не
          може да управлява профили. Превключи към неограничен профил от библиотеката.
        </div>
      )}

      <div className="profiles-grid">
        {profiles?.map((profile) => (
          <ProfileCard
            key={profile.id}
            profile={profile}
            disabled={restricted}
            onChanged={load}
          />
        ))}
      </div>

      {profiles && !restricted && <CreateProfile onCreated={load} />}
    </main>
  );
}

function ProfileCard({
  profile,
  disabled,
  onChanged,
}: {
  profile: Profile;
  disabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState(profile.name);
  const [maxRating, setMaxRating] = useState(profile.maxRating ?? '');
  const [isKid, setIsKid] = useState(profile.isKid);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const dirty =
    name !== profile.name ||
    maxRating !== (profile.maxRating ?? '') ||
    isKid !== profile.isKid;

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setFailure(null);
    setMessage(null);
    try {
      await action();
      await onChanged();
      setMessage(done);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'Неуспешно действие');
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card profile-card" style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong>{profile.name}</strong>
        {profile.hasPin && <span title="Заключен с PIN">🔒</span>}
        {profile.isKid && (
          <span className="muted" style={{ fontSize: 13 }}>
            детски
          </span>
        )}
      </div>

      <label className="muted" style={{ fontSize: 13 }}>
        Име
        <input value={name} onChange={(e) => setName(e.target.value)} disabled={disabled} />
      </label>

      <label className="muted" style={{ fontSize: 13 }}>
        Максимален рейтинг
        <select
          value={maxRating}
          onChange={(e) => setMaxRating(e.target.value)}
          disabled={disabled}
          style={{ width: '100%' }}
        >
          <option value="">Без ограничение</option>
          {RATING_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.ratings.map((rating) => (
                <option key={rating} value={rating}>
                  {rating}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      {maxRating && (
        <div className="muted" style={{ fontSize: 13 }}>
          Скрива всичко над {maxRating}, <strong>както и нерейтингваното</strong>. Рейтингите
          от другата скала също се скриват, защото не са сравними.
        </div>
      )}

      <label className="muted" style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={isKid}
          onChange={(e) => setIsKid(e.target.checked)}
          disabled={disabled}
          style={{ width: 'auto' }}
        />
        Детски профил
      </label>

      <div className="profile-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          disabled={disabled || busy || !dirty}
          onClick={() =>
            run(
              () =>
                api.patch(`/profiles/${profile.id}`, {
                  name,
                  isKid,
                  // Empty means "no cap", which the API expects as null rather
                  // than an empty string.
                  maxRating: maxRating === '' ? null : maxRating,
                }),
              'Запазено.',
            )
          }
        >
          Запази
        </button>

        {profile.hasPin ? (
          <button
            style={{ background: 'transparent' }}
            disabled={disabled || busy}
            onClick={() => run(() => api.delete(`/profiles/${profile.id}/pin`), 'PIN махнат.')}
          >
            Махни PIN
          </button>
        ) : (
          <>
            <input
              className="pin-input"
              type="password"
              inputMode="numeric"
              placeholder="нов PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              disabled={disabled}
              style={{ width: 120 }}
            />
            <button
              disabled={disabled || busy || !pin}
              onClick={() =>
                run(async () => {
                  await api.post(`/profiles/${profile.id}/pin`, { pin });
                  setPin('');
                }, 'Профилът е заключен.')
              }
            >
              Заключи
            </button>
          </>
        )}

        <button
          style={{ background: 'transparent', borderColor: 'var(--danger)', color: 'var(--danger)' }}
          disabled={disabled || busy}
          onClick={() => {
            // Deleting takes the profile's watch history and watchlist with
            // it, so this asks before it happens.
            if (
              !window.confirm(
                `Да изтрия ли „${profile.name}"? Историята на гледане и списъкът му се изтриват заедно с него.`,
              )
            ) {
              return;
            }
            void run(() => api.delete(`/profiles/${profile.id}`), 'Изтрит.');
          }}
        >
          Изтрий
        </button>
      </div>

      {message && <div className="muted" style={{ fontSize: 13 }}>{message}</div>}
      {failure && <div className="error">{failure}</div>}
    </article>
  );
}

function CreateProfile({ onCreated }: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  return (
    <form
      className="card create-profile-card"
      style={{ display: 'grid', gap: 10, marginTop: 24, maxWidth: 360 }}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setFailure(null);
        try {
          await api.post('/profiles', { name: name.trim() });
          setName('');
          await onCreated();
        } catch (err) {
          setFailure(err instanceof Error ? err.message : 'Неуспешно създаване');
        } finally {
          setBusy(false);
        }
      }}
    >
      <strong>Нов профил</strong>
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Име"
        aria-label="Име на новия профил"
      />
      {failure && <div className="error">{failure}</div>}
      <button type="submit" disabled={busy || !name.trim()}>
        Създай
      </button>
      <div className="muted" style={{ fontSize: 13 }}>
        Рейтингът и PIN-ът се задават след създаването.
      </div>
    </form>
  );
}
