import { AmfEncoder } from './transcode.constants';

/**
 * Bitrate budget for one rendition.
 *
 * Left unset, AMF picks its own target and it is wildly high: a 720p
 * rendition of a 1080p HEVC source measured 19.9 Mbps against the source's
 * 5.2 Mbps, so the downscaled copy came out 3.4x *larger* than the original
 * (16.5 GB vs 4.87 GB). At that rate the library does not fit on the disk,
 * which made this look like a storage problem rather than an encoder
 * configuration problem.
 */
export interface BitrateBudget {
  /** Average target for the video stream, in kbit/s. */
  videoKbps: number;
  /** Ceiling the encoder may reach on hard scenes. */
  maxrateKbps: number;
  /** Rate-control buffer; two seconds at the ceiling. */
  bufsizeKbps: number;
  /** Audio target, in kbit/s. */
  audioKbps: number;
}

/**
 * Average H.264 targets for VOD, by rendition height. These are ordinary
 * streaming-service numbers, chosen to be visually clean on a TV at normal
 * viewing distance rather than to be archival.
 */
const H264_TARGET_KBPS: ReadonlyArray<{ height: number; kbps: number }> = [
  { height: 360, kbps: 800 },
  { height: 480, kbps: 1400 },
  { height: 720, kbps: 3000 },
  { height: 1080, kbps: 5500 },
  { height: 1440, kbps: 9000 },
  { height: 2160, kbps: 16000 },
];

/**
 * HEVC reaches comparable quality at roughly two thirds the bitrate of H.264.
 * Deliberately conservative -- the usual claim is half, which tends to hold
 * for slow software encoders more than for hardware ones.
 */
const HEVC_EFFICIENCY = 0.65;

/** Headroom over the average for hard scenes. */
const PEAK_MULTIPLIER = 1.5;

/** AAC is transparent enough well below this for stereo material. */
const AUDIO_KBPS = 160;

/**
 * Surround needs more than stereo to avoid sounding worse than the source it
 * came from -- a 5.1 track squeezed into a stereo budget is a downgrade the
 * viewer did not ask for.
 */
const SURROUND_KBPS = 384;

/** Audio target for one track, by how many channels it carries. */
export function audioKbpsFor(channels: number | undefined): number {
  return (channels ?? 2) > 2 ? SURROUND_KBPS : AUDIO_KBPS;
}

export function bitrateBudgetFor(encoder: AmfEncoder, targetHeight: number): BitrateBudget {
  // The smallest rung that still covers the requested height, so an unusual
  // height is funded like the next standard one up rather than starved.
  const rung =
    H264_TARGET_KBPS.find((r) => r.height >= targetHeight) ??
    H264_TARGET_KBPS[H264_TARGET_KBPS.length - 1];

  const videoKbps = Math.round(
    encoder === 'hevc_amf' ? rung.kbps * HEVC_EFFICIENCY : rung.kbps,
  );
  const maxrateKbps = Math.round(videoKbps * PEAK_MULTIPLIER);

  return {
    videoKbps,
    maxrateKbps,
    bufsizeKbps: maxrateKbps * 2,
    audioKbps: AUDIO_KBPS,
  };
}
