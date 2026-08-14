export const TRANSCODE_QUEUE = 'transcode';

export type AmfEncoder = 'h264_amf' | 'hevc_amf';

export const AMF_ENCODERS: ReadonlyArray<AmfEncoder> = ['h264_amf', 'hevc_amf'];

/**
 * Rendition heights we are willing to produce.
 *
 * Constrained rather than free-form because the height reaches ffmpeg as a
 * scale filter and an output directory name. An arbitrary number produced
 * junk renditions -- a height whose scaled width falls below 128 px is
 * refused outright by h264_amf, and the failure only showed up in the
 * encoder's stderr.
 */
export const ALLOWED_HEIGHTS: ReadonlyArray<number> = [360, 480, 720, 1080, 1440, 2160];

export interface TranscodeJobInput {
  mediaFileId: string;
  encoder: AmfEncoder;
  targetHeight: number;
}

export interface TranscodeJobData extends TranscodeJobInput {
  transcodeJobId: string;
}

/**
 * Identifies the rendition a job produces, and doubles as the BullMQ job id so
 * Redis refuses a second job for the same output.
 *
 * The encoder is deliberately absent: TranscodeProcessor writes to
 * `{outputRoot}/{mediaFileId}/{height}p`, which does not include it, so an
 * h264_amf and an hevc_amf job for the same height would land in one directory
 * and overwrite each other's segments.
 *
 * BullMQ rejects a custom id containing ":", hence the underscore.
 */
export function renditionKey(mediaFileId: string, targetHeight: number): string {
  return `${mediaFileId}_${targetHeight}p`;
}
