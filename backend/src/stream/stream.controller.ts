import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import * as path from 'path';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { JwtService } from '@nestjs/jwt';
import { ContentAccessService } from '../catalog/content-access.service';
import { streamFile } from '../common/stream-file';
import { StreamService } from './stream.service';

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

@UseGuards(JwtAuthGuard)
@Controller('stream')
export class StreamController {
  constructor(
    private readonly stream: StreamService,
    private readonly access: ContentAccessService,
    private readonly jwt: JwtService,
  ) {}

  @Get(':mediaFileId/token')
  async issuePlaybackToken(@Req() req: any, @Param('mediaFileId') mediaFileId: string) {
    await this.access.assertMediaFileAllowed(req.user, mediaFileId);
    if (req.user.scope === 'playback') throw new BadRequestException('A playback token cannot mint another token');
    return {
      token: this.jwt.sign(
        { sub: req.user.sub, email: req.user.email, isAdmin: req.user.isAdmin, profileId: req.user.profileId, scope: 'playback', mediaFileId, sv: req.user.sv },
        { expiresIn: '5m' },
      ),
      expiresInSec: 300,
    };
  }

  // Every route below serves the content itself, so each one repeats the
  // parental-control check. It is deliberately not done once in a guard: the
  // segment route is the one that actually hands over video, and a check that
  // sits only on the routes a well-behaved client visits first is exactly the
  // hole this closes.
  @Get(':mediaFileId')
  async listRenditions(@Req() req: any, @Param('mediaFileId') mediaFileId: string) {
    await this.access.assertMediaFileAllowed(req.user, mediaFileId);
    return this.stream.listRenditions(mediaFileId);
  }

  /** Tells the client whether to play the original or an HLS rendition. */
  @Get(':mediaFileId/playback')
  async getPlaybackPlan(@Req() req: any, @Param('mediaFileId') mediaFileId: string) {
    await this.access.assertMediaFileAllowed(req.user, mediaFileId);
    return this.stream.getPlaybackPlan(mediaFileId);
  }

  /**
   * Serves the original file with HTTP range support. Range handling is
   * mandatory rather than an optimisation: without 206 responses the browser
   * cannot seek, and some refuse to start a large file at all.
   */
  @Get(':mediaFileId/direct')
  async getDirect(
    @Param('mediaFileId') mediaFileId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.access.assertMediaFileAllowed(req.user, mediaFileId);

    const filePath = await this.stream.getSourcePath(mediaFileId);
    const { size } = await stat(filePath);

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', contentTypeFor(filePath));

    const range = parseByteRange(req.headers.range, size);

    if (range === 'unsatisfiable') {
      res.status(416).setHeader('Content-Range', `bytes */${size}`);
      res.end();
      return;
    }

    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      res.setHeader('Content-Length', range.end - range.start + 1);
    } else {
      res.setHeader('Content-Length', size);
    }

    if (size === 0) {
      res.end();
      return;
    }

    const file = createReadStream(filePath, {
      start: range ? range.start : 0,
      end: range ? range.end : size - 1,
    });
    // Seeking makes the browser abandon requests constantly. pipe() does not
    // close the source when the destination goes away, so without this every
    // seek leaks an open file handle for as long as the process lives.
    res.on('close', () => file.destroy());
    file.pipe(res);
  }

  /**
   * Serves everything inside a rendition directory: the entry playlist, the
   * per-stream variant playlists a master refers to, and the segments.
   *
   * One route rather than three because they share a directory and the same
   * validation; the content type follows from the file, since a playlist and
   * a segment cannot be told apart by their position in the path.
   */
  @Get(':mediaFileId/:height/:file')
  async getRenditionFile(
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
    @Param('mediaFileId') mediaFileId: string,
    @Param('height') height: string,
    @Param('file') file: string,
  ): Promise<StreamableFile> {
    await this.access.assertMediaFileAllowed(req.user, mediaFileId);

    const rendition = await this.stream.getRenditionFile(
      mediaFileId,
      parseHeight(height),
      file,
    );

    res.setHeader('Content-Type', rendition.contentType);
    // Segments never change once written; a playlist can be replaced by a
    // re-transcode, so it must not be cached.
    res.setHeader(
      'Cache-Control',
      rendition.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    );
    return streamFile(rendition.path);
  }
}

interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parses a single byte range per RFC 9110 section 14.1.
 *
 * Returns `null` when the client asked for the whole file (header absent, or
 * present but unparsable), `'unsatisfiable'` when the request is well-formed
 * but lies outside the file, and the resolved range otherwise. The three
 * outcomes are distinct because they map to 200, 416 and 206 respectively.
 */
function parseByteRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;

  // Either "bytes=first-[last]" or the suffix form "bytes=-length". Anything
  // else -- including multi-range requests, which we do not serve -- is
  // ignored rather than rejected: the spec says an unparsable Range must be
  // treated as though it were absent.
  const match = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/.exec(header.trim());
  if (!match) return null;

  const [, firstPos, lastPos, suffixLength] = match;

  if (suffixLength !== undefined) {
    // "bytes=-500" means the LAST 500 bytes. Players ask for this to find the
    // moov atom of an MP4 that was not written faststart.
    const length = Number(suffixLength);
    if (length === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const start = Number(firstPos);
  if (start >= size) return 'unsatisfiable';

  // An end past EOF is clamped, not refused. Clients routinely ask for more
  // than the file holds -- "bytes=0-99999999999" is a common opening move.
  const end = lastPos ? Math.min(Number(lastPos), size - 1) : size - 1;
  if (end < start) return 'unsatisfiable';

  return { start, end };
}

function parseHeight(height: string): number {
  const value = Number(height);
  if (!Number.isInteger(value)) {
    throw new BadRequestException('height must be an integer');
  }
  return value;
}
