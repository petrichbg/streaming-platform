'use client';

import type Hls from 'hls.js';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
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
  type Rendition,
  type SubtitleTrackInfo,
  type TitleDetail,
  type WatchProgressEntry,
} from '@/lib/api';
import { PlayerControls, type PlayerOption } from './PlayerControls';
import { CastButton } from './CastButton';

const SAVE_INTERVAL_MS = 10_000;
const MAX_MEDIA_RECOVERY_ATTEMPTS = 2;
const MAX_NETWORK_RECOVERY_ATTEMPTS = 2;
// Below this the position counts as "not really started", and past
// (duration - this) as "finished", so neither resumes mid-credits.
const RESUME_EDGE_SEC = 15;

interface SubtitleCue {
  index: number;
  label: string;
  language: string;
  src: string;
}

interface AudioOption {
  id: number;
  label: string;
}

interface NextEpisode {
  mediaFileId: string;
  label: string;
}

interface PreviewInfo {
  intervalSec: number;
  frames: number;
  width: number;
  urlTemplate: string;
}

interface PlayerPreferences {
  volume: number;
  muted: boolean;
  subtitles: string;
  audio: string;
  autoplayNext: boolean;
  subtitleOffset: number;
  subtitleScale: number;
  subtitleColor: string;
  subtitleBackground: string;
}

const DEFAULT_PREFERENCES: PlayerPreferences = {
  volume: 1,
  muted: false,
  subtitles: 'bul',
  audio: 'bul',
  autoplayNext: true,
  subtitleOffset: 0,
  subtitleScale: 1,
  subtitleColor: '#f4f5f6',
  subtitleBackground: 'rgba(5, 9, 12, 0.82)',
};

// The master playlist carries ISO 639-2 codes. Only the ones this library
// actually contains are named; anything else falls back to the raw code,
// which is still more useful than "audio_2".
const LANGUAGE_NAMES: Record<string, string> = {
  bg: 'Български',
  'bg-bg': 'Български',
  bul: 'Български',
  bulgarian: 'Български',
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
  const stageRef = useRef<HTMLDivElement>(null);
  const controlsTimerRef = useRef<number | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const cueTimesRef = useRef(new Map<string, { start: number; end: number }>());
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
  const [subtitleTrackIndex, setSubtitleTrackIndex] = useState<number | null>(null);
  const [subtitleStatus, setSubtitleStatus] = useState<string>('Зареждане на субтитри…');
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [renditions, setRenditions] = useState<Rendition[]>([]);
  const [quality, setQuality] = useState('auto');
  const [titleName, setTitleName] = useState('Възпроизвеждане');
  const [episodeLabel, setEpisodeLabel] = useState<string | null>(null);
  const [nextEpisode, setNextEpisode] = useState<NextEpisode | null>(null);
  const [autoplayNext, setAutoplayNext] = useState(true);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [subtitleOffset, setSubtitleOffset] = useState(0);
  const [subtitleScale, setSubtitleScale] = useState(1);
  const [subtitleColor, setSubtitleColor] = useState('#f4f5f6');
  const [subtitleBackground, setSubtitleBackground] = useState('rgba(5, 9, 12, 0.82)');
  const [previewInfo, setPreviewInfo] = useState<PreviewInfo | null>(null);

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
        const [media, profiles, playbackPlan, scopedToken, availableRenditions, timelinePreview] = await Promise.all([
          api.get<MediaFileInfo>(`/media/${mediaFileId}`),
          api.get<Profile[]>('/profiles'),
          api.get<PlaybackPlan>(`/stream/${mediaFileId}/playback`),
          api.get<{ token: string }>(`/stream/${mediaFileId}/token`),
          api.get<Rendition[]>(`/stream/${mediaFileId}`),
          api.get<PreviewInfo | null>(`/stream/${mediaFileId}/preview`),
        ]);
        if (cancelled) return;

        const sortedRenditions = [...availableRenditions].sort((a, b) => b.height - a.height);
        setRenditions(sortedRenditions);
        setPlan(playbackPlan);
        setPreviewInfo(timelinePreview ? { ...timelinePreview, urlTemplate: `${API_URL}${timelinePreview.urlTemplate}` } : null);
        setPlaybackToken(scopedToken.token);

        // Whoever the viewer picked in the catalog, not simply the first
        // profile on the account: progress is keyed on the profile, so
        // guessing here writes one viewer's resume position over another's.
        const profile = resolveProfile(profiles);
        if (!profile) return;

        setProfileName(profile.name);
        setProfileId(profile.id);
        contextRef.current = { profileId: profile.id, media };

        const preferences = readPlayerPreferences(profile.id);
        setVolume(preferences.volume);
        setMuted(preferences.muted);
        setAutoplayNext(preferences.autoplayNext);
        setSubtitleOffset(preferences.subtitleOffset);
        setSubtitleScale(preferences.subtitleScale);
        setSubtitleColor(preferences.subtitleColor);
        setSubtitleBackground(preferences.subtitleBackground);

        if (media.titleId) {
          const detail = await api.get<TitleDetail>(`/titles/${media.titleId}`);
          if (!cancelled) {
            setTitleName(detail.name);
            if (media.episodeId) {
              const currentIndex = detail.episodes.findIndex((episode) => episode.id === media.episodeId);
              const current = detail.episodes[currentIndex];
              const next = detail.episodes[currentIndex + 1];
              if (current) {
                setEpisodeLabel(`С${current.seasonNumber} Е${current.episodeNumber}${current.name ? ` · ${current.name}` : ''}`);
              }
              if (next?.mediaFiles[0]) {
                setNextEpisode({
                  mediaFileId: next.mediaFiles[0].id,
                  label: `С${next.seasonNumber} Е${next.episodeNumber}${next.name ? ` · ${next.name}` : ''}`,
                });
              }
            }
          }
        }

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
        const usable = tracks
          .filter((t) => t.convertible)
          .sort((a, b) => Number(isBulgarian(b.language)) - Number(isBulgarian(a.language)));

        if (usable.length === 0) {
          if (!cancelled) {
            setSubtitles([]);
            setSubtitleTrackIndex(null);
            setSubtitleStatus(
              tracks.length > 0
                ? 'Субтитрите в този файл са графични (PGS/VobSub) и браузърът не може да ги покаже.'
                : 'Този видео файл няма вградени субтитри.',
            );
          }
          return;
        }

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
              label: `${subtitleLabel(track.language, track.index)}${track.forced ? ' · Forced' : ''}`,
              language: track.language ?? 'und',
              src: url,
            };
          }),
        );

        if (!cancelled) {
          setSubtitles(cues);
          const preferred = profileId ? readPlayerPreferences(profileId).subtitles : 'bul';
          const selected = cues.find((cue) => languageMatches(cue.language, preferred)) ?? cues[0];
          const forced = tracks.find((track) => track.convertible && track.forced);
          setSubtitleTrackIndex(preferred === 'off' ? forced?.index ?? null : selected?.index ?? null);
          setSubtitleStatus('');
        }
      } catch (err) {
        // Subtitles are optional; a failure here must not block playback, but
        // hiding it entirely makes a broken extraction look like no tracks.
        if (!cancelled) {
          setSubtitles([]);
          setSubtitleTrackIndex(null);
          setSubtitleStatus(
            err instanceof Error
              ? `Субтитрите не можаха да се заредят: ${err.message}`
              : 'Субтитрите не можаха да се заредят.',
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      created.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [mediaFileId, playbackToken, profileId]);

  // Chromium does not consistently expose dynamically inserted <track>
  // elements in its native overflow menu. Drive the TextTrack modes here and
  // provide our own selector below the player instead.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const applySelection = () => {
      for (let i = 0; i < video.textTracks.length; i += 1) {
        const track = video.textTracks[i];
        const streamIndex = Number(track.id);
        track.mode = subtitleTrackIndex !== null && streamIndex === subtitleTrackIndex
          ? 'showing'
          : 'disabled';
        if (track.cues) {
          for (let cueIndex = 0; cueIndex < track.cues.length; cueIndex += 1) {
            const cue = track.cues[cueIndex];
            const key = `${track.id}:${cueIndex}`;
            const original = cueTimesRef.current.get(key) ?? { start: cue.startTime, end: cue.endTime };
            cueTimesRef.current.set(key, original);
            cue.startTime = Math.max(0, original.start + subtitleOffset);
            cue.endTime = Math.max(cue.startTime + 0.05, original.end + subtitleOffset);
          }
        }
      }
    };

    applySelection();
    const timer = window.setTimeout(applySelection, 0);
    const trackElements = [...video.querySelectorAll('track')];
    trackElements.forEach((element) => element.addEventListener('load', applySelection));
    return () => {
      window.clearTimeout(timer);
      trackElements.forEach((element) => element.removeEventListener('load', applySelection));
    };
  }, [subtitles, subtitleTrackIndex, subtitleOffset]);

  // ---- attach the source, per the playback plan ---------------------------
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !plan?.url) return;

    const token = getToken();
    const seek = () => {
      const target = pendingSeekRef.current ?? resumeAt;
      pendingSeekRef.current = null;
      if (target > 0) video.currentTime = target;
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
    let mediaRecoveryAttempts = 0;
    let networkRecoveryAttempts = 0;
    let lastMediaRecoveryAt = 0;
    void import('hls.js').then(({ default: HlsRuntime }) => {
      if (disposed) return;
      if (!HlsRuntime.isSupported()) {
        setError('Този браузър не поддържа защитеното HLS възпроизвеждане.');
        return;
      }
      const hls = new HlsRuntime({
        xhrSetup: (xhr) => {
          if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        },
      });
      instance = hls;
      hls.on(HlsRuntime.Events.ERROR, (_event, data) => {
        if (!data.fatal || disposed) return;

        // A SourceBuffer can require a fresh MediaSource after a decoder or
        // timestamp discontinuity. hls.js exposes recoverMediaError() for
        // exactly this case; surfacing the first reset as a terminal error
        // leaves an otherwise valid H.264/AAC stream on a blank frame.
        if (data.type === HlsRuntime.ErrorTypes.MEDIA_ERROR) {
          const now = Date.now();
          if (now - lastMediaRecoveryAt > 30_000) mediaRecoveryAttempts = 0;
          lastMediaRecoveryAt = now;
          mediaRecoveryAttempts += 1;
          if (mediaRecoveryAttempts <= MAX_MEDIA_RECOVERY_ATTEMPTS) {
            setError(null);
            if (mediaRecoveryAttempts === MAX_MEDIA_RECOVERY_ATTEMPTS) {
              hls.swapAudioCodec();
            }
            hls.recoverMediaError();
            return;
          }
        }

        if (data.type === HlsRuntime.ErrorTypes.NETWORK_ERROR) {
          networkRecoveryAttempts += 1;
          if (networkRecoveryAttempts <= MAX_NETWORK_RECOVERY_ATTEMPTS) {
            setError(null);
            hls.startLoad();
            return;
          }
        }

        setError(`Playback error: ${data.type} / ${data.details}`);
      });
      hls.on(HlsRuntime.Events.FRAG_BUFFERED, () => {
        networkRecoveryAttempts = 0;
        setError(null);
      });
      hls.on(HlsRuntime.Events.MANIFEST_PARSED, seek);
      const readAudioTracks = () => {
        const options = hls.audioTracks.map((track, index) => ({ id: track.id, label: audioLabel(track, index) }));
        const preferred = profileId ? readPlayerPreferences(profileId).audio : 'bul';
        const preferredTrack = options.find((option) => option.label === LANGUAGE_NAMES[preferred]);
        if (preferredTrack) hls.audioTrack = preferredTrack.id;
        setAudioTracks(options);
        setAudioTrackId(preferredTrack?.id ?? hls.audioTrack);
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
  }, [plan, resumeAt, playbackToken, profileId]);

  function selectAudioTrack(id: number) {
    // hls.js keeps playing across the switch; it refetches the audio segments
    // for the current position by itself.
    if (hlsRef.current) hlsRef.current.audioTrack = id;
    setAudioTrackId(id);
    const selected = audioTracks.find((track) => track.id === id);
    if (profileId && selected) updatePlayerPreferences(profileId, { audio: languageCodeForLabel(selected.label) });
  }

  function seekBy(seconds: number) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + seconds));
  }

  async function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) await video.play();
    else video.pause();
  }

  async function toggleFullscreen() {
    const stage = stageRef.current;
    if (!stage) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await stage.requestFullscreen();
  }

  async function togglePictureInPicture() {
    const video = videoRef.current;
    if (!video || !document.pictureInPictureEnabled) return;
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await video.requestPictureInPicture();
  }

  function setPlayerVolume(nextVolume: number) {
    const video = videoRef.current;
    const normalized = Math.max(0, Math.min(1, nextVolume));
    setVolume(normalized);
    setMuted(false);
    if (video) {
      video.volume = normalized;
      video.muted = false;
    }
    if (profileId) updatePlayerPreferences(profileId, { volume: normalized, muted: false });
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    if (videoRef.current) videoRef.current.muted = next;
    if (profileId) updatePlayerPreferences(profileId, { muted: next });
  }

  function selectSubtitle(value: string) {
    const index = value === 'off' ? null : Number(value);
    setSubtitleTrackIndex(index);
    if (profileId) {
      const selected = subtitles.find((track) => track.index === index);
      updatePlayerPreferences(profileId, { subtitles: selected?.language ?? 'off' });
    }
  }

  function selectQuality(value: string) {
    if (plan?.mode !== 'hls') return;
    const hls = hlsRef.current;
    if (hls && hls.levels.length > 1) {
      if (value === 'auto') hls.currentLevel = -1;
      else {
        const level = hls.levels.findIndex((item) => item.height === Number(value));
        if (level >= 0) hls.currentLevel = level;
      }
      setQuality(value);
      return;
    }
    const selected = value === 'auto' ? renditions[0] : renditions.find((rendition) => rendition.height === Number(value));
    if (!selected) return;
    pendingSeekRef.current = videoRef.current?.currentTime ?? currentTime;
    setQuality(value);
    setPlan({ ...plan, url: selected.playlistUrl });
  }

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = window.setTimeout(() => {
      if (!videoRef.current?.paused) setControlsVisible(false);
    }, 3000);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const sync = () => {
      setIsPlaying(!video.paused);
      setCurrentTime(video.currentTime || 0);
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      setBuffered(video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) : 0);
    };
    const ended = () => {
      if (autoplayNext && nextEpisode) router.push(`/watch/${nextEpisode.mediaFileId}`);
    };
    video.volume = volume;
    video.muted = muted;
    for (const event of ['play', 'pause', 'timeupdate', 'progress', 'durationchange', 'loadedmetadata']) video.addEventListener(event, sync);
    video.addEventListener('ended', ended);
    return () => {
      for (const event of ['play', 'pause', 'timeupdate', 'progress', 'durationchange', 'loadedmetadata']) video.removeEventListener(event, sync);
      video.removeEventListener('ended', ended);
    };
  }, [autoplayNext, nextEpisode, router, volume, muted]);

  useEffect(() => {
    const fullscreenChanged = () => setIsFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', fullscreenChanged);
    return () => document.removeEventListener('fullscreenchange', fullscreenChanged);
  }, []);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, select, textarea, button')) return;
      if (event.code === 'Space' || event.key.toLowerCase() === 'k') {
        event.preventDefault();
        void togglePlayback();
      } else if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'j') {
        event.preventDefault();
        seekBy(-10);
      } else if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'l') {
        event.preventDefault();
        seekBy(10);
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        void toggleFullscreen();
      } else if (event.key.toLowerCase() === 'm') {
        event.preventDefault();
        toggleMute();
      }
      showControls();
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  });

  useEffect(() => () => {
    if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
  }, []);

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

  const subtitleOptions: PlayerOption[] = [
    { value: 'off', label: 'Изключени' },
    ...subtitles.map((track) => ({ value: String(track.index), label: track.label })),
  ];
  const audioOptions: PlayerOption[] = audioTracks.map((track) => ({ value: String(track.id), label: track.label }));
  const qualityOptions: PlayerOption[] = plan?.mode === 'hls'
    ? [{ value: 'auto', label: `Автоматично${renditions[0] ? ` · ${renditions[0].height}p` : ''}` }, ...renditions.map((item) => ({ value: String(item.height), label: `${item.height}p` }))]
    : [{ value: 'source', label: 'Оригинално' }];

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

      <div
        className={`player-stage${controlsVisible ? ' controls-visible' : ''}${isFullscreen ? ' is-fullscreen' : ''}`}
        ref={stageRef}
        onPointerMove={showControls}
        onPointerDown={showControls}
      >
        <video
          className="cinema-player"
          ref={videoRef}
          playsInline
          style={{
            '--subtitle-scale': subtitleScale,
            '--subtitle-color': subtitleColor,
            '--subtitle-background': subtitleBackground,
          } as CSSProperties}
        >
          {subtitles.map((cue) => (
            <track key={cue.index} id={String(cue.index)} kind="subtitles" label={cue.label} srcLang={cue.language} src={cue.src} />
          ))}
        </video>
        <PlayerControls
          visible={controlsVisible}
          playing={isPlaying}
          currentTime={currentTime}
          duration={duration}
          buffered={buffered}
          volume={volume}
          muted={muted}
          title={titleName}
          subtitle={episodeLabel}
          subtitleOptions={subtitleOptions}
          subtitleValue={subtitleTrackIndex === null ? 'off' : String(subtitleTrackIndex)}
          audioOptions={audioOptions}
          audioValue={audioTrackId === null ? '' : String(audioTrackId)}
          qualityOptions={qualityOptions}
          qualityValue={plan?.mode === 'hls' ? quality : 'source'}
          previewInfo={previewInfo}
          previewToken={getToken()}
          pictureInPictureSupported={typeof document !== 'undefined' && document.pictureInPictureEnabled}
          fullscreen={isFullscreen}
          onActivity={showControls}
          onLeave={() => { if (isPlaying) setControlsVisible(false); }}
          onTogglePlayback={() => void togglePlayback()}
          onSeek={seekBy}
          onScrub={(seconds) => { if (videoRef.current) videoRef.current.currentTime = seconds; }}
          onVolume={setPlayerVolume}
          onToggleMute={toggleMute}
          onSubtitle={selectSubtitle}
          onAudio={(value) => selectAudioTrack(Number(value))}
          onQuality={selectQuality}
          onPictureInPicture={() => void togglePictureInPicture()}
          onFullscreen={() => void toggleFullscreen()}
        />
      </div>

      <div className="player-aftercare">
        <CastButton
          sourceUrl={plan && plan.mode !== 'unavailable' && plan.url && playbackToken ? `${API_URL}${plan.url}${plan.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(playbackToken)}` : null}
          contentType={plan?.mode === 'hls' ? 'application/x-mpegURL' : 'video/mp4'}
          title={episodeLabel ? `${titleName} · ${episodeLabel}` : titleName}
        />
        <div className="player-meta muted">
          <span>{plan?.mode === 'direct' ? 'Оригинално качество' : plan?.mode === 'hls' ? 'Адаптирано HLS възпроизвеждане' : 'Недостъпно'}</span>
          {profileName && <span>Профил: {profileName}</span>}
          {subtitles.length === 0 && <span>{subtitleStatus}</span>}
        </div>
        {subtitles.length > 0 && (
          <details className="subtitle-appearance">
            <summary>Настройки на субтитрите</summary>
            <div>
              <label>Синхронизация <span>{subtitleOffset > 0 ? '+' : ''}{subtitleOffset.toFixed(1)} сек.</span>
                <input type="range" min="-10" max="10" step="0.1" value={subtitleOffset} onChange={(event) => {
                  const value = Number(event.target.value); setSubtitleOffset(value);
                  if (profileId) updatePlayerPreferences(profileId, { subtitleOffset: value });
                }} />
              </label>
              <label>Размер
                <select value={subtitleScale} onChange={(event) => {
                  const value = Number(event.target.value); setSubtitleScale(value);
                  if (profileId) updatePlayerPreferences(profileId, { subtitleScale: value });
                }}><option value="0.8">Малък</option><option value="1">Стандартен</option><option value="1.2">Голям</option><option value="1.4">Много голям</option></select>
              </label>
              <label>Цвят
                <select value={subtitleColor} onChange={(event) => {
                  setSubtitleColor(event.target.value);
                  if (profileId) updatePlayerPreferences(profileId, { subtitleColor: event.target.value });
                }}><option value="#f4f5f6">Бял</option><option value="#f4df72">Жълт</option><option value="#9ed6ff">Светлосин</option></select>
              </label>
              <label>Фон
                <select value={subtitleBackground} onChange={(event) => {
                  setSubtitleBackground(event.target.value);
                  if (profileId) updatePlayerPreferences(profileId, { subtitleBackground: event.target.value });
                }}><option value="rgba(5, 9, 12, 0.82)">Плътен</option><option value="rgba(5, 9, 12, 0.52)">Полупрозрачен</option><option value="transparent">Без фон</option></select>
              </label>
            </div>
          </details>
        )}
        {nextEpisode && (
          <div className="next-episode-strip">
            <div><span>Следващ епизод</span><strong>{nextEpisode.label}</strong></div>
            <label><input type="checkbox" checked={autoplayNext} onChange={(event) => {
              setAutoplayNext(event.target.checked);
              if (profileId) updatePlayerPreferences(profileId, { autoplayNext: event.target.checked });
            }} /> Автоматично продължаване</label>
            <button type="button" onClick={() => router.push(`/watch/${nextEpisode.mediaFileId}`)}>Пусни сега</button>
          </div>
        )}
      </div>

    </main>
  );
}

function subtitleLabel(language: string | null, index: number): string {
  const normalized = language?.toLowerCase();
  if (normalized && LANGUAGE_NAMES[normalized]) return LANGUAGE_NAMES[normalized];
  if (normalized && normalized !== 'und') return normalized;
  return `Писта ${index}`;
}

function isBulgarian(language: string | null): boolean {
  if (!language) return false;
  return ['bg', 'bg-bg', 'bul', 'bulgarian'].includes(language.toLowerCase());
}

function languageMatches(language: string, preference: string): boolean {
  if (preference === 'bul') return isBulgarian(language);
  return language.toLowerCase() === preference.toLowerCase();
}

function languageCodeForLabel(label: string): string {
  const match = Object.entries(LANGUAGE_NAMES).find(([, name]) => name === label);
  return match?.[0] ?? label.toLowerCase();
}

function preferenceKey(profileId: string): string {
  return `streaming_player_preferences:${profileId}`;
}

function readPlayerPreferences(profileId: string): PlayerPreferences {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCES;
  try {
    const stored = JSON.parse(window.localStorage.getItem(preferenceKey(profileId)) ?? '{}') as Partial<PlayerPreferences>;
    return { ...DEFAULT_PREFERENCES, ...stored };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function updatePlayerPreferences(profileId: string, patch: Partial<PlayerPreferences>): void {
  const next = { ...readPlayerPreferences(profileId), ...patch };
  window.localStorage.setItem(preferenceKey(profileId), JSON.stringify(next));
}
