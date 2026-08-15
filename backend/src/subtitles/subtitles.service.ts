import {
  BadRequestException,
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
const EXTERNAL_TRACK_INDEX_BASE = 10_000;

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
  externalPath?: string;
  fileName?: string;
  encoding?: 'utf-8' | 'windows-1251';
  source?: 'embedded' | 'external';
  matchConfidence?: number;
}

export interface SubtitleTrackInfo extends SubtitleTrack {
  /** False for bitmap formats (PGS/VobSub) that cannot become WebVTT. */
  convertible: boolean;
  bitmap: boolean;
  bitmapHandling: 'none' | 'burn-in';
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
    const tracks = [
      ...this.readTracks(mediaFile.subtitleTracks).map((track) => ({ ...track, source: 'embedded' as const })),
      ...(await this.findExternalTracks(mediaFile.sourcePath)),
    ];

    // Tell the client up front which tracks it can actually request,
    // rather than making it discover this via a failed fetch.
    return tracks.map((track) => ({
      index: track.index,
      codec: track.codec,
      language: track.language,
      forced: track.forced,
      fileName: track.fileName,
      encoding: track.encoding,
      source: track.source,
      matchConfidence: track.matchConfidence,
      convertible: isTextCodec(track.codec),
      bitmap: !isTextCodec(track.codec),
      bitmapHandling: isTextCodec(track.codec) ? 'none' : 'burn-in',
    }));
  }

  /** Returns the filesystem path of a WebVTT rendition, extracting it on first request. */
  async getVttPath(mediaFileId: string, streamIndex: number): Promise<string> {
    const mediaFile = await this.getMediaFile(mediaFileId);
    const tracks = [
      ...this.readTracks(mediaFile.subtitleTracks).map((track) => ({ ...track, source: 'embedded' as const })),
      ...(await this.findExternalTracks(mediaFile.sourcePath)),
    ];
    const track = tracks.find((t) => t.index === streamIndex);

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
    const sourcePath = track.externalPath ?? path.join(mediaRoot, mediaFile.sourcePath);
    await fs.mkdir(cacheDir, { recursive: true });

    // -map 0:<index> uses the absolute ffprobe stream index recorded at
    // import time, so it addresses the right stream regardless of how many
    // audio/video streams precede it.
    const ffmpegArgs = [
      '-y',
      ...(track.externalPath && track.encoding === 'windows-1251' ? ['-sub_charenc', 'windows-1251'] : []),
      '-i',
      sourcePath,
      ...(track.externalPath ? [] : ['-map', `0:${streamIndex}`]),
      '-c:s',
      'webvtt',
      '-f',
      'webvtt',
      cachePath,
    ];
    await execFileAsync('ffmpeg', ffmpegArgs);

    this.logger.log(`Extracted subtitle track ${streamIndex} of ${mediaFileId} to WebVTT`);
    return cachePath;
  }

  async uploadExternal(
    mediaFileId: string,
    file: { originalname: string; buffer: Buffer; size: number },
    language = 'bul',
    forced = false,
  ): Promise<SubtitleTrackInfo[]> {
    if (!file?.buffer?.length) throw new BadRequestException('Subtitle file is required');
    if (file.size > 5 * 1024 * 1024) throw new BadRequestException('Subtitle file must be 5 MB or smaller');

    const extension = path.extname(file.originalname).toLowerCase();
    if (!['.srt', '.ass', '.ssa', '.vtt'].includes(extension)) {
      throw new BadRequestException('Supported subtitle formats: SRT, ASS, SSA and VTT');
    }

    const mediaFile = await this.getMediaFile(mediaFileId);
    const mediaRoot = this.config.get<string>('media.root')!;
    const videoPath = this.safeMediaPath(mediaRoot, mediaFile.sourcePath);
    const videoBase = path.basename(videoPath, path.extname(videoPath));
    const normalizedLanguage = normalizeLanguage(language);
    const suffix = forced ? `${normalizedLanguage}.forced` : normalizedLanguage;
    const destination = path.join(path.dirname(videoPath), `${videoBase}.${suffix}${extension}`);

    await fs.writeFile(destination, file.buffer, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw new BadRequestException('A subtitle with this language already exists');
      throw error;
    });
    this.logger.log(`Uploaded external subtitle ${path.basename(destination)} for ${mediaFileId}`);
    return this.listTracks(mediaFileId);
  }

  async deleteExternal(mediaFileId: string, streamIndex: number): Promise<SubtitleTrackInfo[]> {
    const mediaFile = await this.getMediaFile(mediaFileId);
    const track = (await this.findExternalTracks(mediaFile.sourcePath)).find((item) => item.index === streamIndex);
    if (!track?.externalPath) throw new NotFoundException('External subtitle track not found');
    await fs.unlink(track.externalPath);
    const outputRoot = this.config.get<string>('transcode.outputRoot')!;
    await fs.rm(path.join(outputRoot, 'subtitles', mediaFileId, `${streamIndex}.vtt`), { force: true });
    return this.listTracks(mediaFileId);
  }

  async readExternalSource(mediaFileId: string, streamIndex: number) {
    const track = await this.getExternalTrack(mediaFileId, streamIndex);
    const raw = await fs.readFile(track.externalPath!);
    return {
      content: new TextDecoder(track.encoding === 'windows-1251' ? 'windows-1251' : 'utf-8').decode(raw),
      fileName: track.fileName,
      encoding: track.encoding,
    };
  }

  async updateExternalSource(mediaFileId: string, streamIndex: number, content: string) {
    if (typeof content !== 'string' || content.length > 5 * 1024 * 1024) {
      throw new BadRequestException('Subtitle content must be text up to 5 MB');
    }
    const track = await this.getExternalTrack(mediaFileId, streamIndex);
    await fs.writeFile(track.externalPath!, content, 'utf8');
    const outputRoot = this.config.get<string>('transcode.outputRoot')!;
    await fs.rm(path.join(outputRoot, 'subtitles', mediaFileId, `${streamIndex}.vtt`), { force: true });
    return this.readExternalSource(mediaFileId, streamIndex);
  }

  getCapabilities() {
    return {
      textFormats: ['srt', 'ass', 'ssa', 'vtt'],
      encodings: ['utf-8', 'windows-1251'],
      bitmapCodecs: ['hdmv_pgs_subtitle', 'dvd_subtitle'],
      burnInFilterAvailable: true,
      ocrAvailable: false,
      bitmapPlaybackAvailable: false,
      bitmapReason: 'Tesseract OCR and the bitmap-to-text pipeline are not installed.',
    };
  }

  private readTracks(raw: unknown): SubtitleTrack[] {
    return Array.isArray(raw) ? (raw as unknown as SubtitleTrack[]) : [];
  }

  private async getExternalTrack(mediaFileId: string, streamIndex: number): Promise<SubtitleTrack> {
    const mediaFile = await this.getMediaFile(mediaFileId);
    const track = (await this.findExternalTracks(mediaFile.sourcePath)).find((item) => item.index === streamIndex);
    if (!track?.externalPath) throw new NotFoundException('External subtitle track not found');
    return track;
  }

  /** Finds matching subtitles next to the video and one directory below it. */
  private async findExternalTracks(sourcePath: string): Promise<SubtitleTrack[]> {
    const mediaRoot = this.config.get<string>('media.root')!;
    const videoPath = this.safeMediaPath(mediaRoot, sourcePath);
    const directory = path.dirname(videoPath);
    const videoBase = path.basename(videoPath, path.extname(videoPath));

    let candidates: string[];
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      candidates = entries.filter((entry) => entry.isFile()).map((entry) => path.join(directory, entry.name));
      const children = entries.filter((entry) => entry.isDirectory()).slice(0, 40);
      for (const child of children) {
        const childPath = path.join(directory, child.name);
        const childEntries = await fs.readdir(childPath, { withFileTypes: true }).catch(() => []);
        candidates.push(...childEntries.filter((entry) => entry.isFile()).map((entry) => path.join(childPath, entry.name)));
      }
    } catch {
      return [];
    }

    const matches = candidates
      .map((filePath) => ({ filePath, score: subtitleMatchScore(videoBase, path.basename(filePath, path.extname(filePath))) }))
      .filter(({ filePath, score }) => ['.srt', '.ass', '.ssa', '.vtt'].includes(path.extname(filePath).toLowerCase()) && score >= 55)
      .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));

    const tracks: SubtitleTrack[] = [];
    for (const [position, match] of matches.entries()) {
      const name = path.basename(match.filePath);
      tracks.push({
      index: EXTERNAL_TRACK_INDEX_BASE + position,
      codec: externalCodec(name),
      language: inferLanguage(name),
      forced: /(?:^|[. _-])forced(?:[. _-]|$)/i.test(name),
      externalPath: match.filePath,
      fileName: path.relative(directory, match.filePath),
      encoding: await detectEncoding(match.filePath),
      source: 'external',
      matchConfidence: match.score,
      });
    }
    return tracks;
  }

  private safeMediaPath(mediaRoot: string, sourcePath: string): string {
    const root = path.resolve(mediaRoot);
    const resolved = path.resolve(path.join(root, sourcePath));
    if (!resolved.startsWith(root + path.sep)) throw new BadRequestException('Invalid media path');
    return resolved;
  }

  private async getMediaFile(mediaFileId: string) {
    const mediaFile = await this.prisma.mediaFile.findUnique({ where: { id: mediaFileId } });
    if (!mediaFile) {
      throw new NotFoundException(`Media file ${mediaFileId} not found`);
    }
    return mediaFile;
  }
}

export function isTextCodec(codec: string | null | undefined): boolean {
  return !!codec && TEXT_SUBTITLE_CODECS.has(codec.toLowerCase());
}

function externalCodec(fileName: string): string {
  switch (path.extname(fileName).toLowerCase()) {
    case '.ass':
      return 'ass';
    case '.ssa':
      return 'ssa';
    case '.vtt':
      return 'webvtt';
    default:
      return 'subrip';
  }
}

function normalizeForMatch(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\b(2160p|1080p|720p|480p|bluray|webrip|web[-_. ]?dl|hdtv|x26[45]|h[. ]?26[45]|av1|repack)\b/g, ' ')
    .replace(/[^a-z0-9а-я]+/giu, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 1 && !['bg', 'bul', 'forced', 'subs', 'subtitle'].includes(token));
}

export function subtitleMatchScore(videoBase: string, subtitleBase: string): number {
  const video = videoBase.toLowerCase();
  const subtitle = subtitleBase.toLowerCase().replace(/[._ -](bg|bul|forced)$/i, '');
  if (video === subtitle) return 100;

  const videoEpisode = /s(\d{1,2})e(\d{1,3})/i.exec(video);
  const subtitleEpisode = /s(\d{1,2})e(\d{1,3})/i.exec(subtitle);
  if (videoEpisode && (!subtitleEpisode || videoEpisode[1] !== subtitleEpisode[1] || videoEpisode[2] !== subtitleEpisode[2])) return 0;

  const videoTokens = new Set(normalizeForMatch(video));
  const subtitleTokens = new Set(normalizeForMatch(subtitle));
  if (videoTokens.size === 0 || subtitleTokens.size === 0) return 0;
  const overlap = [...videoTokens].filter((token) => subtitleTokens.has(token)).length;
  const union = new Set([...videoTokens, ...subtitleTokens]).size;
  const jaccard = overlap / union;
  const containment = overlap / Math.min(videoTokens.size, subtitleTokens.size);
  return Math.round(jaccard * 55 + containment * 45);
}

function inferLanguage(fileName: string): string {
  const name = fileName.toLowerCase();
  if (/(?:^|[. _-])(en|eng)(?:[. _-]|$)/.test(name)) return 'eng';
  if (/(?:^|[. _-])(ru|rus)(?:[. _-]|$)/.test(name)) return 'rus';
  if (/(?:^|[. _-])(el|ell|gre)(?:[. _-]|$)/.test(name)) return 'ell';
  return 'bul';
}

export function normalizeLanguage(language: string): string {
  const normalized = language.trim().toLowerCase();
  if (['bg', 'bg-bg', 'bul', 'bulgarian'].includes(normalized)) return 'bul';
  if (!/^[a-z]{2,3}$/.test(normalized)) throw new BadRequestException('Language must be a 2 or 3 letter code');
  return normalized;
}

export async function detectEncoding(filePath: string): Promise<'utf-8' | 'windows-1251'> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
      return 'utf-8';
    } catch {
      return 'windows-1251';
    }
  } finally {
    await handle.close();
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
