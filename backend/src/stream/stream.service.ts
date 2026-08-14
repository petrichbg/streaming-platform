import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { directPlayBlockers } from '../common/playability';
import { PrismaService } from '../prisma/prisma.service';

// Everything TranscodeProcessor is capable of writing into a rendition
// directory, and nothing else. A name that does not match one of these was not
// produced here, so it is refused before the disk is touched.
//
// The first two are the current layout (a master playlist plus one variant per
// stream); the last is the older single-playlist layout, kept so renditions
// transcoded before multi-audio still play.
const RENDITION_FILES: ReadonlyArray<{ pattern: RegExp; contentType: string; immutable: boolean }> = [
  { pattern: /^master\.m3u8$/, contentType: 'application/vnd.apple.mpegurl', immutable: false },
  { pattern: /^stream_\d{1,2}\.m3u8$/, contentType: 'application/vnd.apple.mpegurl', immutable: false },
  { pattern: /^stream_\d{1,2}_\d{5}\.ts$/, contentType: 'video/mp2t', immutable: true },
  { pattern: /^index\.m3u8$/, contentType: 'application/vnd.apple.mpegurl', immutable: false },
  { pattern: /^segment_\d{5}\.ts$/, contentType: 'video/mp2t', immutable: true },
];

/** Written by the multi-audio layout; absent on renditions older than it. */
const MASTER_PLAYLIST = 'master.m3u8';

export interface RenditionFile {
  path: string;
  contentType: string;
  /** Segments never change once written; playlists can be re-transcoded. */
  immutable: boolean;
}

export interface Rendition {
  height: number;
  playlistUrl: string;
}

export interface PlaybackPlan {
  /** "unavailable" means a transcode is required but none exists yet. */
  mode: 'direct' | 'hls' | 'unavailable';
  url: string | null;
  reason: string;
}


@Injectable()
export class StreamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async listRenditions(mediaFileId: string): Promise<Rendition[]> {
    const mediaFile = await this.prisma.mediaFile.findUnique({ where: { id: mediaFileId } });
    if (!mediaFile) {
      throw new NotFoundException(`Media file ${mediaFileId} not found`);
    }

    const jobs = await this.prisma.transcodeJob.findMany({
      where: { mediaFileId, status: 'DONE' },
      orderBy: { targetHeight: 'asc' },
    });

    // De-duplicate: re-running a transcode leaves several DONE rows for the
    // same height, all pointing at the same output directory.
    const heights = [...new Set(jobs.map((j) => j.targetHeight))];

    return heights.map((height) => ({
      height,
      playlistUrl: `/stream/${mediaFileId}/${height}/index.m3u8`,
    }));
  }

  /**
   * Resolves one file inside a rendition: the entry playlist, a variant
   * playlist, or a segment.
   *
   * `index.m3u8` stays the advertised entry point so rendition URLs did not
   * have to change, but it now resolves to the master playlist when one
   * exists. Renditions produced before multi-audio have a real index.m3u8 and
   * keep working.
   */
  async getRenditionFile(
    mediaFileId: string,
    height: number,
    file: string,
  ): Promise<RenditionFile> {
    const match = RENDITION_FILES.find((candidate) => candidate.pattern.test(file));
    if (!match) {
      throw new BadRequestException('Invalid rendition file name');
    }

    const dir = this.renditionDir(mediaFileId, height);
    const name = file === 'index.m3u8' && (await exists(path.join(dir, MASTER_PLAYLIST)))
      ? MASTER_PLAYLIST
      : file;
    const filePath = path.join(dir, name);

    // Belt and braces: even with the patterns above, confirm the resolved path
    // never escapes the rendition directory before reading it.
    const resolvedDir = path.resolve(dir);
    if (!path.resolve(filePath).startsWith(resolvedDir + path.sep)) {
      throw new BadRequestException('Invalid rendition file path');
    }

    if (!(await exists(filePath))) {
      throw new NotFoundException(
        `${file} not found for the ${height}p rendition of media file ${mediaFileId}`,
      );
    }

    return { path: filePath, contentType: match.contentType, immutable: match.immutable };
  }

  /**
   * Decides whether the browser can play the original file as-is.
   *
   * Transcoding a whole library up front is expensive in both time and disk,
   * and most of it is unnecessary: an MP4 carrying H.264/AAC plays natively
   * everywhere. Only what the browser cannot handle -- notably MKV containers
   * and HEVC video -- needs an HLS rendition.
   */
  async getPlaybackPlan(mediaFileId: string): Promise<PlaybackPlan> {
    const mediaFile = await this.prisma.mediaFile.findUnique({ where: { id: mediaFileId } });
    if (!mediaFile) {
      throw new NotFoundException(`Media file ${mediaFileId} not found`);
    }

    const blockers = directPlayBlockers(mediaFile);

    if (blockers.length === 0) {
      return {
        mode: 'direct',
        url: `/stream/${mediaFileId}/direct`,
        reason: 'Browser-compatible container and codecs',
      };
    }

    const renditions = await this.listRenditions(mediaFileId);
    return {
      mode: renditions.length > 0 ? 'hls' : 'unavailable',
      url: renditions[0]?.playlistUrl ?? null,
      reason: `Needs transcode: ${blockers.join(', ')}`,
    };
  }

  /** Absolute path of the original file, for direct play. */
  async getSourcePath(mediaFileId: string): Promise<string> {
    const mediaFile = await this.prisma.mediaFile.findUnique({ where: { id: mediaFileId } });
    if (!mediaFile) {
      throw new NotFoundException(`Media file ${mediaFileId} not found`);
    }

    const mediaRoot = this.config.get<string>('media.root')!;
    const resolved = path.resolve(path.join(mediaRoot, mediaFile.sourcePath));

    // sourcePath comes from our own scanner, but it is still a stored string;
    // confirm it never escapes MEDIA_ROOT before opening it.
    if (!resolved.startsWith(path.resolve(mediaRoot) + path.sep)) {
      throw new BadRequestException('Invalid source path');
    }
    return resolved;
  }

  private renditionDir(mediaFileId: string, height: number): string {
    if (!Number.isInteger(height) || height <= 0 || height > 4320) {
      throw new BadRequestException('Invalid rendition height');
    }
    // mediaFileId comes straight off the route, so constrain it to the uuid
    // shape Prisma generates before it ever reaches path.join.
    if (!/^[0-9a-fA-F-]{36}$/.test(mediaFileId)) {
      throw new BadRequestException('Invalid media file id');
    }

    const outputRoot = this.config.get<string>('transcode.outputRoot')!;
    return path.join(outputRoot, mediaFileId, `${height}p`);
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
