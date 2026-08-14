import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { PrismaService } from '../prisma/prisma.service';

const execFileAsync = promisify(execFile);

// Text-based subtitle codecs ffmpeg can convert to WebVTT. Anything else
// (notably BluRay PGS and DVD VobSub) is a bitmap image stream and would
// need OCR, which is out of scope here — we return a clear error instead
// of letting ffmpeg fail with something opaque.
const TEXT_SUBTITLE_CODECS = new Set([
  'subrip',
  'srt',
  'ass',
  'ssa',
  'mov_text',
  'webvtt',
  'text',
]);

export interface SubtitleTrack {
  index: number;
  codec: string | null;
  language: string | null;
  forced?: boolean;
}

export interface SubtitleTrackInfo extends SubtitleTrack {
  /** False for bitmap formats (PGS/VobSub) that cannot become WebVTT. */
  convertible: boolean;
}

@Injectable()
export class SubtitlesService {
  private readonly logger = new Logger(SubtitlesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async listTracks(mediaFileId: string): Promise<SubtitleTrackInfo[]> {
    const mediaFile = await this.getMediaFile(mediaFileId);

    // Tell the client up front which tracks it can actually request,
    // rather than making it discover this via a failed fetch.
    return this.readTracks(mediaFile.subtitleTracks).map((track) => ({
      ...track,
      convertible: isTextCodec(track.codec),
    }));
  }

  /** Returns the filesystem path of a WebVTT rendition, extracting it on first request. */
  async getVttPath(mediaFileId: string, streamIndex: number): Promise<string> {
    const mediaFile = await this.getMediaFile(mediaFileId);
    const track = this.readTracks(mediaFile.subtitleTracks).find((t) => t.index === streamIndex);

    if (!track) {
      throw new NotFoundException(`No subtitle track with index ${streamIndex} on this file`);
    }
    if (!isTextCodec(track.codec)) {
      throw new UnprocessableEntityException(
        `Subtitle track ${streamIndex} is "${track.codec}", a bitmap format that cannot be ` +
          `converted to WebVTT without OCR. Supply an external .srt for this title instead.`,
      );
    }

    const outputRoot = this.config.get<string>('transcode.outputRoot')!;
    const cacheDir = path.join(outputRoot, 'subtitles', mediaFileId);
    const cachePath = path.join(cacheDir, `${streamIndex}.vtt`);

    if (await exists(cachePath)) {
      return cachePath;
    }

    const mediaRoot = this.config.get<string>('media.root')!;
    const sourcePath = path.join(mediaRoot, mediaFile.sourcePath);
    await fs.mkdir(cacheDir, { recursive: true });

    // -map 0:<index> uses the absolute ffprobe stream index recorded at
    // import time, so it addresses the right stream regardless of how many
    // audio/video streams precede it.
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      sourcePath,
      '-map',
      `0:${streamIndex}`,
      '-c:s',
      'webvtt',
      '-f',
      'webvtt',
      cachePath,
    ]);

    this.logger.log(`Extracted subtitle track ${streamIndex} of ${mediaFileId} to WebVTT`);
    return cachePath;
  }

  private readTracks(raw: unknown): SubtitleTrack[] {
    return Array.isArray(raw) ? (raw as unknown as SubtitleTrack[]) : [];
  }

  private async getMediaFile(mediaFileId: string) {
    const mediaFile = await this.prisma.mediaFile.findUnique({ where: { id: mediaFileId } });
    if (!mediaFile) {
      throw new NotFoundException(`Media file ${mediaFileId} not found`);
    }
    return mediaFile;
  }
}

function isTextCodec(codec: string | null | undefined): boolean {
  return !!codec && TEXT_SUBTITLE_CODECS.has(codec.toLowerCase());
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
