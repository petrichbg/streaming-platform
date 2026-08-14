'use client';

import type Hls from 'hls.js';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  API_URL,
  ApiError,
  clearToken,
  getToken,
  resolveProfile,
  type MediaFileInfo,
  type PlaybackPlan,
  type Profile,
  type SubtitleTrackInfo,
  type WatchProgressEntry,
} from '@/lib/api';

const SAVE_INTERVAL_MS = 10_000;
// Below this the position counts as "not really started", and past
// (duration - this) as "finished", so neither resumes mid-credits.
const RESUME_EDGE_SEC = 15;

interface SubtitleCue {
  index: number;
  label: string;
  src: string;
}

interface AudioOption {
  id: number;
  label: string;
}

// The master playlist carries ISO 639-2 codes. Only the ones this library
// actually contains are named; anything else falls back to the raw code,
// which is still more useful than "audio_2".
const LANGUAGE_NAMES: Record<string, string> = {
  bul: 'Български',
  eng: 'Английски',
  fre: 'Френски',
  fra: 'Френски',
  gre: 'Гръцки',
  ell: 'Гръцки',
  und: 'Неизвестен',
};

function audioLabel(track: { name?: string; lang?: string }, index: number): string {
  const lang = track.lang?.toLowerCase();
  if (lang && LANGUAGE_NAMES[lang]) return LANGUAGE_NAMES[lang];
  if (lang && lang !== 'und') return lang;
  // ffmpeg names untagged tracks audio_1, audio_2 — useless to a viewer, so
  // fall back to a position instead.
  return `Писта ${index + 1}`;
}

export default function WatchPage() {
  const params = useParams<{ mediaFileId: string }>();
  const router = useRouter();
  const mediaFileId = params.mediaFileId;

  const videoRef = useRef<HTMLVideoElement>(null);
  // Kept in a ref so the save timer and unmount cleanup always see the latest
  // values without re-creating the timer on every state change.
  const contextRef = useRef<{ profileId: string; media: MediaFileInfo } | null>(null);

  const [plan, setPlan] = useState<PlaybackPlan | null>(null);
  const [playbackToken, setPlaybackToken] = useState<string | null>(null);
  const [profileName, setProfileName] = useState<string | null>(null);
  const [resumeAt, setResumeAt] = useState(0);
  const [audioTracks, setAudioTracks] = useState<AudioOption[]>([]);
  const [audioTrackId, setAudioTrackId] = useState<number | null>(null);
  // Held so the audio picker can drive the running instance without the
  // playback effect depending on picker state and tearing itself down.
  const hlsRef = useRef<Hls | null>(null);
  const [subtitles, setSubtitles] = useState<SubtitleCue[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleAuthError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        router.replace('/login');
        return true;
      }
      return false;
    },
    [router],
  );

  // ---- load everything the player needs -----------------------------------
  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const [media, profiles, playbackPlan, scopedToken] = await Promise.all([
          api.get<MediaFileInfo>(`/media/${mediaFileId}`),
          api.get<Profile[]>('/profiles'),
          api.get<PlaybackPlan>(`/stream/${mediaFileId}/playback`),
          api.get<{ token: string }>(`/stream/${mediaFileId}/token`),
        ]);
        if (cancelled) return;

        setPlan(playbackPlan);
        setPlaybackToken(scopedToken.token);

        // Whoever the viewer picked in the catalog, not simply the first
        // profile on the account: progress is keyed on the profile, so
        // guessing here writes one viewer's resume position over another's.
        const profile = resolveProfile(profiles);
        if (!profile) return;

        setProfileName(profile.name);
        contextRef.current = { profileId: profile.id, media };

        const progress = await api.get<WatchProgressEntry[]>(
          `/profiles/${profile.id}/continue-watching`,
        );
        const entry = progress.find((p) =>
          media.episodeId ? p.episodeId === media.episodeId : p.titleId === media.titleId,
        );
        const duration = entry?.durationSec ?? media.durationSec ?? 0;

        if (
          entry &&
          entry.positionSec > RESUME_EDGE_SEC &&
          (!duration || entry.positionSec < duration - RESUME_EDGE_SEC) &&
          !cancelled
        ) {
          setResumeAt(entry.positionSec);
        }
      } catch (err) {
        if (cancelled || handleAuthError(err)) return;
        // A 404 here is usually the parental control rather than a missing
        // file -- the API answers the same way for both on purpose, so the
        // wording must not promise which one it was.
        if (err instanceof ApiError && err.status === 404) {
          setError('Това заглавие не е достъпно за текущия профил.');
          return;
        }
        setError(err instanceof Error ? err.message : 'Грешка при зареждане');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mediaFileId, router, handleAuthError]);

  // ---- subtitles ----------------------------------------------------------
  useEffect(() => {
    const token = playbackToken;
    if (!token) return;

    let cancelled = false;
    const created: string[] = [];

    (async () => {
      try {
        const tracks = await api.get<SubtitleTrackInfo[]>(`/media/${mediaFileId}/subtitles`);
        const usable = tracks.filter((t) => t.convertible);

        // A <track src> cannot carry an Authorization header and the VTT
        // endpoint is guarded, so each track is fetched here and handed to the
        // element as an object URL instead.
        const cues = await Promise.all(
          usable.map(async (track) => {
            const response = await fetch(
              `${API_URL}/media/${mediaFileId}/subtitles/${track.index}`,
              { headers: { Authorization: `Bearer ${token}` } },
            );
            if (!response.ok) throw new Error(`Subtitle ${track.index}: ${response.status}`);
            const url = URL.createObjectURL(await response.blob());
            created.push(url);
            return {
              index: track.index,
              label: track.language ?? `Track ${track.index}`,
              src: url,
            };
          }),
        );

        if (!cancelled) setSubtitles(cues);
      } catch {
        // Subtitles are optional; a failure here must not block playback.
      }
    })();

    return () => {
      cancelled = true;
      created.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [mediaFileId]);

  // ---- attach the source, per the playback plan ---------------------------
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !plan?.url) return;

    const token = getToken();
    const seek = () => {
      if (resumeAt > 0) video.currentTime = resumeAt;
    };

    if (plan.mode === 'direct') {
      // The token rides in the query string because a <video src> cannot send
      // an Authorization header and the file is far too large to blob.
      video.src = `${API_URL}${plan.url}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
      video.addEventListener('loadedmetadata', seek, { once: true });
      return () => video.removeEventListener('loadedmetadata', seek);
    }

    let disposed = false;
    let instance: Hls | null = null;
    void import('hls.js').then(({ default: HlsRuntime }) => {
      if (disposed) return;
      if (!HlsRuntime.isSupported()) {
        setError('Този браузър не поддържа защитеното HLS възпроизвеждане.');
        return;
      }
      const hls = new HlsRuntime({ xhrSetup: (xhr) => { if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`); } });
      instance = hls;
      hls.on(HlsRuntime.Events.ERROR, (_event, data) => { if (data.fatal) setError(`Playback error: ${data.type} / ${data.details}`); });
      hls.on(HlsRuntime.Events.MANIFEST_PARSED, seek);
      const readAudioTracks = () => {
        setAudioTracks(hls.audioTracks.map((track, index) => ({ id: track.id, label: audioLabel(track, index) })));
        setAudioTrackId(hls.audioTrack);
      };
      hls.on(HlsRuntime.Events.AUDIO_TRACKS_UPDATED, readAudioTracks);
      hls.on(HlsRuntime.Events.AUDIO_TRACK_SWITCHED, () => setAudioTrackId(hls.audioTrack));
      hlsRef.current = hls;
      hls.loadSource(`${API_URL}${plan.url}`);
      hls.attachMedia(video);
    }).catch(() => setError('HLS модулът не може да се зареди.'));
    return () => {
      disposed = true;
      hlsRef.current = null;
      setAudioTracks([]);
      instance?.destroy();
    };
  }, [plan, resumeAt, playbackToken]);

  function selectAudioTrack(id: number) {
    // hls.js keeps playing across the switch; it refetches the audio segments
    // for the current position by itself.
    if (hlsRef.current) hlsRef.current.audioTrack = id;
    setAudioTrackId(id);
  }

  // ---- persist progress ---------------------------------------------------
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const save = () => {
      const context = contextRef.current;
      if (!context || video.currentTime < 1) return;

      void api
        .put(`/profiles/${context.profileId}/progress`, {
          titleId: context.media.episodeId ? undefined : context.media.titleId,
          episodeId: context.media.episodeId ?? undefined,
          positionSec: Math.floor(video.currentTime),
          durationSec: Number.isFinite(video.duration) ? Math.floor(video.duration) : undefined,
        })
        .catch(() => {
          // Losing one position update is not worth interrupting playback.
        });
    };

    const timer = setInterval(save, SAVE_INTERVAL_MS);
    video.addEventListener('pause', save);

    return () => {
      clearInterval(timer);
      video.removeEventListener('pause', save);
      save();
    };
  }, [plan]);

  return (
    <main className="player-page" id="main-content">
      <nav className="player-nav">
      <Link href="/" className="back-link">
        &larr; Обратно
      </Link>
      <span className="eyebrow">Кино у дома</span>
      </nav>

      {error && (
        <div className="alert alert-danger player-message" style={{ marginTop: 16 }}>
          {error}
        </div>
      )}

      {plan?.mode === 'unavailable' && (
        <div className="alert alert-secondary player-message" style={{ marginTop: 16 }}>
          Този файл не може да се пусне директно ({plan.reason}) и няма транскодирана
          версия. Пусни <code>POST /transcode</code> за него.
        </div>
      )}

      <video
        className="cinema-player"
        ref={videoRef}
        controls
        style={{
          width: '100%',
          marginTop: 16,
          borderRadius: 12,
          background: '#000',
          aspectRatio: '16 / 9',
        }}
      >
        {subtitles.map((cue) => (
          <track
            key={cue.index}
            kind="subtitles"
            label={cue.label}
            srcLang={cue.label}
            src={cue.src}
          />
        ))}
      </video>

      {audioTracks.length > 1 && (
        <div className="player-controls" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <label htmlFor="audio-track" className="muted" style={{ fontSize: 14 }}>
            Аудио
          </label>
          <select
            id="audio-track"
            value={audioTrackId ?? ''}
            onChange={(event) => selectAudioTrack(Number(event.target.value))}
          >
            {audioTracks.map((track) => (
              <option key={track.id} value={track.id}>
                {track.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="player-meta muted" style={{ marginTop: 8, fontSize: 14 }}>
        {plan?.mode === 'direct' && <>Директно възпроизвеждане</>}
        {plan?.mode === 'hls' && <>Транскодирано (HLS)</>}
        {/* Named because progress is saved against it -- if it is the wrong
            profile the viewer should be able to see that before watching. */}
        {profileName && <> · профил: {profileName}</>}
        {resumeAt > 0 && <> · продължава от {formatTime(resumeAt)}</>}
        {subtitles.length > 0 && <> · субтитри: {subtitles.map((s) => s.label).join(', ')}</>}
      </div>
    </main>
  );
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
