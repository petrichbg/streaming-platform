'use client';

import { useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from 'react';

export interface PlayerOption {
  value: string;
  label: string;
}

interface PlayerControlsProps {
  visible: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
  buffered: number;
  volume: number;
  muted: boolean;
  title: string;
  subtitle: string | null;
  subtitleOptions: PlayerOption[];
  subtitleValue: string;
  audioOptions: PlayerOption[];
  audioValue: string;
  qualityOptions: PlayerOption[];
  qualityValue: string;
  previewInfo: { intervalSec: number; frames: number; width: number; urlTemplate: string } | null;
  previewToken: string | null;
  pictureInPictureSupported: boolean;
  fullscreen: boolean;
  onActivity: () => void;
  onLeave: () => void;
  onTogglePlayback: () => void;
  onSeek: (seconds: number) => void;
  onScrub: (seconds: number) => void;
  onVolume: (volume: number) => void;
  onToggleMute: () => void;
  onSubtitle: (value: string) => void;
  onAudio: (value: string) => void;
  onQuality: (value: string) => void;
  onPictureInPicture: () => void;
  onFullscreen: () => void;
}

export function PlayerControls(props: PlayerControlsProps) {
  const progress = props.duration > 0 ? (props.currentTime / props.duration) * 100 : 0;
  const buffered = props.duration > 0 ? (props.buffered / props.duration) * 100 : 0;
  const [preview, setPreview] = useState<{ time: number; left: number; url: string } | null>(null);

  function scrub(event: ChangeEvent<HTMLInputElement>) {
    props.onScrub(Number(event.target.value));
  }

  function activity(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== 'touch') props.onActivity();
  }

  function previewAt(event: ReactPointerEvent<HTMLDivElement>) {
    if (!props.previewInfo || props.duration <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const time = ratio * props.duration;
    const frame = Math.min(props.previewInfo.frames, Math.floor(time / props.previewInfo.intervalSec) + 1);
    const file = `thumb_${String(frame).padStart(5, '0')}`;
    const path = props.previewInfo.urlTemplate.replace('thumb_{index}', file);
    const url = `${path}${props.previewToken ? `?token=${encodeURIComponent(props.previewToken)}` : ''}`;
    setPreview({ time, left: ratio * 100, url });
  }

  return (
    <div
      className={`player-overlay${props.visible ? ' is-visible' : ''}`}
      onPointerMove={activity}
      onPointerLeave={props.onLeave}
      data-testid="player-controls"
    >
      <button
        type="button"
        className="player-hit-area"
        onClick={props.onTogglePlayback}
        aria-label={props.playing ? 'Пауза' : 'Пускане'}
      />

      <div className="player-overlay-top">
        <div>
          <strong>{props.title}</strong>
          {props.subtitle && <span>{props.subtitle}</span>}
        </div>
        <span className="player-keyboard-hint">Space пауза · ← → превъртане · F цял екран</span>
      </div>

      {!props.playing && (
        <button type="button" className="player-center-play" onClick={props.onTogglePlayback} aria-label="Пускане">
          <Icon name="play" />
        </button>
      )}

      <div className="player-overlay-bottom">
        <div className="player-timeline-wrap" onPointerMove={previewAt} onPointerLeave={() => setPreview(null)}>
          {preview && <div className="player-timeline-preview" style={{ left: `${preview.left}%` }}><img src={preview.url} alt="" /><span>{formatTime(preview.time)}</span></div>}
          <div className="player-buffered" style={{ width: `${buffered}%` }} />
          <div className="player-progress" style={{ width: `${progress}%` }} />
          <input
            className="player-timeline"
            type="range"
            min="0"
            max={Math.max(props.duration, 0)}
            step="0.1"
            value={Math.min(props.currentTime, props.duration || 0)}
            onChange={scrub}
            aria-label="Позиция във видеото"
            aria-valuetext={`${formatTime(props.currentTime)} от ${formatTime(props.duration)}`}
          />
        </div>

        <div className="player-toolbar">
          <div className="player-toolbar-group">
            <ControlButton label={props.playing ? 'Пауза' : 'Пускане'} icon={props.playing ? 'pause' : 'play'} onClick={props.onTogglePlayback} />
            <ControlButton label="Назад 10 секунди" icon="back10" onClick={() => props.onSeek(-10)} />
            <ControlButton label="Напред 10 секунди" icon="forward10" onClick={() => props.onSeek(10)} />
            <ControlButton label={props.muted ? 'Включи звука' : 'Спри звука'} icon={props.muted || props.volume === 0 ? 'muted' : 'volume'} onClick={props.onToggleMute} />
            <input
              className="player-volume"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={props.muted ? 0 : props.volume}
              onChange={(event) => props.onVolume(Number(event.target.value))}
              aria-label="Сила на звука"
            />
            <span className="player-time">{formatTime(props.currentTime)} <i>/</i> {formatTime(props.duration)}</span>
          </div>

          <div className="player-toolbar-group player-toolbar-settings">
            {props.audioOptions.length > 1 && (
              <PlayerSelect label="Аудио" value={props.audioValue} options={props.audioOptions} onChange={props.onAudio} />
            )}
            <PlayerSelect label="Субтитри" value={props.subtitleValue} options={props.subtitleOptions} onChange={props.onSubtitle} />
            {props.qualityOptions.length > 1 && (
              <PlayerSelect label="Качество" value={props.qualityValue} options={props.qualityOptions} onChange={props.onQuality} />
            )}
            {props.pictureInPictureSupported && (
              <ControlButton label="Картина в картината" icon="pip" onClick={props.onPictureInPicture} />
            )}
            <ControlButton label={props.fullscreen ? 'Изход от цял екран' : 'Цял екран'} icon={props.fullscreen ? 'fullscreenExit' : 'fullscreen'} onClick={props.onFullscreen} />
          </div>
        </div>
      </div>
    </div>
  );
}

function PlayerSelect({ label, value, options, onChange }: { label: string; value: string; options: PlayerOption[]; onChange: (value: string) => void }) {
  return (
    <label className="player-select">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={label}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function ControlButton({ label, icon, onClick }: { label: string; icon: IconName; onClick: () => void }) {
  return (
    <button type="button" className="player-icon-button" onClick={onClick} aria-label={label} title={label}>
      <Icon name={icon} />
    </button>
  );
}

type IconName = 'play' | 'pause' | 'back10' | 'forward10' | 'volume' | 'muted' | 'pip' | 'fullscreen' | 'fullscreenExit';

function Icon({ name }: { name: IconName }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...common}>
      {name === 'play' && <path d="M8 5.5v13l11-6.5L8 5.5Z" fill="currentColor" stroke="none" />}
      {name === 'pause' && <><path d="M8 5v14" /><path d="M16 5v14" /></>}
      {name === 'back10' && <><path d="M9 7H5V3" /><path d="M5.4 7A8 8 0 1 1 4 15" /><text x="8" y="16" fill="currentColor" stroke="none" fontSize="8">10</text></>}
      {name === 'forward10' && <><path d="M15 7h4V3" /><path d="M18.6 7A8 8 0 1 0 20 15" /><text x="8" y="16" fill="currentColor" stroke="none" fontSize="8">10</text></>}
      {name === 'volume' && <><path d="M4 10v4h4l5 4V6l-5 4H4Z" /><path d="M16 9a4 4 0 0 1 0 6" /><path d="M18 6a8 8 0 0 1 0 12" /></>}
      {name === 'muted' && <><path d="M4 10v4h4l5 4V6l-5 4H4Z" /><path d="m17 10 4 4m0-4-4 4" /></>}
      {name === 'pip' && <><rect x="3" y="5" width="18" height="14" rx="1.5" /><rect x="12" y="11" width="7" height="5" rx=".5" fill="currentColor" stroke="none" /></>}
      {name === 'fullscreen' && <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></>}
      {name === 'fullscreenExit' && <><path d="M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5" /></>}
    </svg>
  );
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
