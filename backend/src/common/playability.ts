/**
 * Whether a file can be handed to a browser as-is, or needs an HLS rendition.
 *
 * This lives on its own because two callers need the same answer and must not
 * drift apart: StreamService decides what to tell the player, and the bulk
 * transcode decides what still needs encoding. A second copy of these sets
 * would eventually disagree, and the symptom -- a file the player calls
 * unplayable that the transcoder considers already fine, or the reverse --
 * would be slow to spot.
 */

// Matroska (.mkv) is absent on purpose: no major browser supports the
// container, however ordinary its contents.
const DIRECT_CONTAINERS = new Set(['mp4', 'm4v', 'webm']);
const DIRECT_VIDEO_CODECS = new Set(['h264', 'avc1', 'vp8', 'vp9', 'av1']);
const DIRECT_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis']);

export interface PlayableInput {
  container: string | null;
  videoCodec: string | null;
  audioTracks: unknown;
}

/**
 * Lists what stops this file from playing directly. Empty means it plays as-is.
 */
export function directPlayBlockers(mediaFile: PlayableInput): string[] {
  const container = (mediaFile.container ?? '').toLowerCase();
  const videoCodec = (mediaFile.videoCodec ?? '').toLowerCase();
  const audioCodec = firstAudioCodec(mediaFile.audioTracks);

  const blockers: string[] = [];
  if (!DIRECT_CONTAINERS.has(container)) blockers.push(`container ${container || 'unknown'}`);
  if (!DIRECT_VIDEO_CODECS.has(videoCodec)) blockers.push(`video ${videoCodec || 'unknown'}`);
  // No audio stream at all is fine; an unsupported one is not.
  if (audioCodec && !DIRECT_AUDIO_CODECS.has(audioCodec)) blockers.push(`audio ${audioCodec}`);

  return blockers;
}

/** Codec of the first audio track, or null when the file has no audio. */
export function firstAudioCodec(audioTracks: unknown): string | null {
  if (!Array.isArray(audioTracks) || audioTracks.length === 0) return null;
  const codec = (audioTracks[0] as { codec?: string })?.codec;
  return codec ? codec.toLowerCase() : null;
}
