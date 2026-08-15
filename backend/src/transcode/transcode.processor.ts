import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { FfprobeService } from '../media/ffprobe.service';
import { audioKbpsFor, bitrateBudgetFor } from './bitrates';
import { AMF_ENCODERS, AmfEncoder, TRANSCODE_QUEUE, TranscodeEncoder, TranscodeJobData } from './transcode.constants';
import { HlsCleanupService } from './hls-cleanup.service';

/**
 * Target segment length. Segments can only be cut on a keyframe, so the
 * encoder is told to emit one exactly this often; without that the GOP length
 * decides the segment length and `-hls_time` is quietly ignored (observed:
 * 10-second segments against a requested 6).
 */
const HLS_SEGMENT_SECONDS = 6;

/** Fallback when the source does not report a frame rate we can parse. */
const ASSUMED_FPS = 25;

/** Entry point of a rendition: ties the video to the audio track group. */
export const MASTER_PLAYLIST = 'master.m3u8';

@Processor(TRANSCODE_QUEUE)
export class TranscodeProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(TranscodeProcessor.name);
  private readonly activeProcesses = new Map<string, ReturnType<typeof execFile>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly ffprobe: FfprobeService,
    private readonly config: ConfigService,
    private readonly cleanup: HlsCleanupService,
  ) {
    super();
  }

  onModuleInit() {
    const maxH264 = this.config.get<number>('transcode.maxConcurrentH264Amf') ?? 6;
    const maxHevc = this.config.get<number>('transcode.maxConcurrentHevcAmf') ?? 6;
    // Both encoders share the same physical AMF encode block on this GPU
    // (see docs/ARCHITECTURE.md) and this single worker processes jobs for
    // both encoder types through one queue, so the safe combined cap is the
    // smaller of the two tested limits, not their sum -- running 6 h264_amf
    // and 6 hevc_amf jobs at once was never tested and is not assumed safe.
    this.worker.concurrency = Math.min(maxH264, maxHevc);
  }

  async process(job: Job<TranscodeJobData>): Promise<void> {
    const { transcodeJobId, mediaFileId, encoder, targetHeight } = job.data;

    await this.prisma.transcodeJob.update({
      where: { id: transcodeJobId },
      data: { status: 'RUNNING', startedAt: new Date(), attempt: job.data.attempt ?? 1 },
    });

    try {
      let outputPath: string;
      try {
        outputPath = await this.runFfmpeg(transcodeJobId, mediaFileId, encoder, targetHeight);
      } catch (error) {
        const message = (error as Error).message;
        const current = await this.prisma.transcodeJob.findUnique({ where: { id: transcodeJobId } });
        if (current?.status === 'CANCELLED') throw error;
        if (!AMF_ENCODERS.includes(encoder as AmfEncoder) || !isAmfFailure(message)) throw error;
        this.logger.warn(`AMF failed for job ${transcodeJobId}; retrying once with libx264`);
        await this.cleanup.discardWork(mediaFileId, targetHeight, transcodeJobId);
        await this.prisma.transcodeJob.update({
          where: { id: transcodeJobId },
          data: { encoder: 'libx264', fallbackFrom: encoder, error: `AMF fallback: ${message.slice(0, 1500)}` },
        });
        outputPath = await this.runFfmpeg(transcodeJobId, mediaFileId, 'libx264', targetHeight);
      }
      const current = await this.prisma.transcodeJob.findUnique({ where: { id: transcodeJobId } });
      if (current?.status === 'CANCELLED') {
        await this.cleanup.removeRendition(mediaFileId, targetHeight);
        this.logger.warn(`Discarded completed output for cancelled job ${transcodeJobId}`);
        return;
      }
      await this.prisma.transcodeJob.update({
        where: { id: transcodeJobId },
        data: { status: 'DONE', finishedAt: new Date(), outputPath, error: null },
      });
      await this.ensureTimelinePreview(mediaFileId).catch((error) => {
        this.logger.warn(`Timeline preview generation skipped for ${mediaFileId}: ${(error as Error).message}`);
      });
    } catch (err) {
      const message = (err as Error).message;
      await this.cleanup.discardWork(mediaFileId, targetHeight, transcodeJobId);
      const current = await this.prisma.transcodeJob.findUnique({ where: { id: transcodeJobId } });
      if (current?.status === 'CANCELLED') {
        this.logger.warn(`Transcode job ${transcodeJobId} cancelled`);
        return;
      }
      this.logger.error(`Transcode job ${transcodeJobId} failed: ${message}`);
      await this.prisma.transcodeJob.update({
        where: { id: transcodeJobId },
        data: { status: 'FAILED', finishedAt: new Date(), error: message.slice(0, 2000) },
      });
      throw err;
    }
  }

  private async runFfmpeg(
    transcodeJobId: string,
    mediaFileId: string,
    encoder: TranscodeEncoder,
    targetHeight: number,
  ): Promise<string> {
    const mediaFile = await this.prisma.mediaFile.findUniqueOrThrow({
      where: { id: mediaFileId },
    });

    const mediaRoot = this.config.get<string>('media.root')!;
    const sourcePath = path.join(mediaRoot, mediaFile.sourcePath);
    const outDir = await this.cleanup.prepare(mediaFileId, targetHeight, transcodeJobId);
    // "%v" is replaced with the variant index: stream_0 is the video, and one
    // stream_N follows per audio track. Everything lands flat in one directory
    // so the paths stay easy to validate on the way back out.
    const playlistPattern = path.join(outDir, 'stream_%v.m3u8');
    const segmentPattern = path.join(outDir, 'stream_%v_%05d.ts');
    const masterPath = path.join(outDir, MASTER_PLAYLIST);

    // Probed once, for three reasons: pixel format, frame rate (to size the
    // GOP) and the audio track list.
    const probe = await this.ffprobe.probe(sourcePath);
    const videoStream = probe.streams.find((s) => s.codec_type === 'video');
    const audioStreams = probe.streams.filter((s) => s.codec_type === 'audio');

    // h264_amf (like most hardware H.264 encoders) only accepts 8-bit input.
    // Downsample 10-bit sources before encoding -- discovered the hard way in
    // scripts/gpu-test/test-amf-capacity.ps1, see docs/ARCHITECTURE.md.
    const videoFilters: string[] = [];
    if (encoder === 'h264_amf' && videoStream && this.ffprobe.isHighBitDepth(videoStream)) {
      videoFilters.push('format=nv12');
    }
    videoFilters.push(`scale=-2:${targetHeight}`);

    const budget = bitrateBudgetFor(encoder, targetHeight);
    const gopFrames = Math.round(parseFrameRate(videoStream?.r_frame_rate) * HLS_SEGMENT_SECONDS);

    // Every audio track is carried, not just the first. Bulgarian releases
    // routinely ship BG audio alongside the original, and keeping only track
    // zero silently picked one for the viewer.
    const audioMaps: string[] = [];
    const audioOptions: string[] = [];
    // A single audio stream belongs in the same variant as the video. Besides
    // producing a simpler manifest, this avoids two independent MediaSource
    // buffers for the overwhelmingly common case. Multiple language tracks
    // still use alternate renditions so the player can switch between them.
    const variants = audioStreams.length === 0
      ? ['v:0']
      : audioStreams.length === 1
        ? ['v:0,a:0']
        : ['v:0,agroup:aud'];

    audioStreams.forEach((stream, index) => {
      audioMaps.push('-map', `0:a:${index}`);
      // AAC 5.1 may signal its channel layout through a Program Config
      // Element that is emitted only at the beginning of the stream. A player
      // starting from a later HLS segment then sees 0 channels / sample-rate 0
      // and Chromium closes its MediaSource. Stereo uses the ADTS channel
      // configuration on every frame and is safe for arbitrary seek starts.
      audioOptions.push(`-ac:a:${index}`, '2');
      audioOptions.push(`-b:a:${index}`, `${audioKbpsFor(2)}k`);
      if (audioStreams.length > 1) {
        variants.push(
          [
            `a:${index}`,
            'agroup:aud',
            `language:${languageTagFor(stream)}`,
            // Something has to be the default or players pick unpredictably.
            ...(index === 0 ? ['default:yes'] : []),
          ].join(','),
        );
      }
    });

    const encoderArgs = encoder === 'libx264'
      ? ['-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p']
      : [
          '-c:v', encoder,
          '-quality', 'balanced',
          '-rc', 'vbr_peak',
          '-vbaq', '1',
        ];

    const args = [
      '-y',
      '-i', sourcePath,
      // Explicit stream selection. Without -map, ffmpeg's default selection
      // also hands subtitle streams to the HLS muxer, which then emits
      // WebVTT segments (index0.vtt, index1.vtt, ...) instead of the video
      // playlist -- observed on a source with embedded subrip tracks.
      // Subtitles are served separately by SubtitlesModule, so they are
      // deliberately excluded here. The trailing "?" makes audio optional so
      // a silent source does not fail the whole job.
      '-map', '0:v:0',
      ...audioMaps,
      '-sn',
      '-vf', videoFilters.join(','),
      ...encoderArgs,
      '-b:v', `${budget.videoKbps}k`,
      '-maxrate', `${budget.maxrateKbps}k`,
      '-bufsize', `${budget.bufsizeKbps}k`,
      // A segment can only start on a keyframe. Pinning the GOP to the segment
      // length is what actually makes -hls_time below take effect.
      '-g', String(gopFrames),
      '-keyint_min', String(gopFrames),
      '-force_key_frames', `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`,
      '-c:a', 'aac',
      ...audioOptions,
      // Splits the output into one playlist per stream and writes a master
      // that ties the audio group to the video. Without this the tracks are
      // muxed together and the player has nothing to switch between.
      '-var_stream_map', variants.join(' '),
      '-master_pl_name', MASTER_PLAYLIST,
      '-f', 'hls',
      '-hls_time', String(HLS_SEGMENT_SECONDS),
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', segmentPattern,
      playlistPattern,
    ];

    await new Promise<void>((resolve, reject) => {
      const child = execFile('ffmpeg', args, { maxBuffer: 20 * 1024 * 1024 }, (error, _stdout, stderr) => {
        this.activeProcesses.delete(transcodeJobId);
        if (!error) return resolve();

        // execFile's own message is just the command line, so a failed job
        // used to land in the database saying nothing about why. ffmpeg
        // explains itself on stderr; keep the tail of it, and put it first
        // because the stored error is truncated to 2000 characters.
        const reason = stderr.trim().split(/\r?\n/).slice(-12).join('\n');
        this.logger.error(`ffmpeg failed for ${masterPath}\n${stderr.trim().slice(-4000)}`);
        reject(new Error(`ffmpeg failed: ${reason || error.message}`));
      });
      this.activeProcesses.set(transcodeJobId, child);
    });

    return this.cleanup.publish(mediaFileId, targetHeight, transcodeJobId);
  }

  async cancelJob(transcodeJobId: string): Promise<boolean> {
    const child = this.activeProcesses.get(transcodeJobId);
    if (!child?.pid) return false;
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => resolve());
      });
    } else {
      child.kill('SIGTERM');
    }
    return true;
  }

  private async ensureTimelinePreview(mediaFileId: string): Promise<void> {
    const outputRoot = this.config.get<string>('transcode.outputRoot')!;
    const mediaRoot = this.config.get<string>('media.root')!;
    if (typeof outputRoot !== 'string' || typeof mediaRoot !== 'string') return;
    const mediaDir = path.join(outputRoot, mediaFileId);
    const previewDir = path.join(mediaDir, 'preview');
    const metadataPath = path.join(previewDir, 'metadata.json');
    try { await fs.access(metadataPath); return; } catch { /* generate */ }

    await fs.mkdir(mediaDir, { recursive: true });
    const lockPath = path.join(mediaDir, '.preview.lock');
    let lock: Awaited<ReturnType<typeof fs.open>>;
    try { lock = await fs.open(lockPath, 'wx'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
      throw error;
    }

    const workDir = path.join(mediaDir, `preview.work-${Date.now()}`);
    try {
      const mediaFile = await this.prisma.mediaFile.findUniqueOrThrow({ where: { id: mediaFileId } });
      const sourcePath = path.join(mediaRoot, mediaFile.sourcePath);
      await fs.mkdir(workDir, { recursive: true });
      await execFilePromise('ffmpeg', [
        '-y', '-i', sourcePath, '-vf', 'fps=1/30,scale=320:-2', '-q:v', '4',
        path.join(workDir, 'thumb_%05d.jpg'),
      ]);
      const frames = (await fs.readdir(workDir)).filter((name) => /^thumb_\d{5}\.jpg$/.test(name)).length;
      if (frames === 0) throw new Error('ffmpeg produced no preview frames');
      await fs.writeFile(path.join(workDir, 'metadata.json'), JSON.stringify({ intervalSec: 30, frames, width: 320 }));
      await fs.rm(previewDir, { recursive: true, force: true });
      await fs.rename(workDir, previewDir);
    } finally {
      await lock.close();
      await fs.rm(lockPath, { force: true });
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }
}

function execFilePromise(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 20 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr.trim().split(/\r?\n/).slice(-8).join('\n') || error.message));
      else resolve();
    });
  });
}

function isAmfFailure(message: string): boolean {
  return /\b(amf|vce)\b|hardware encoder|encoder .*not found|initializ(?:e|ation)|device setup failed|no capable devices/i.test(message);
}

/**
 * Language tag for a stream, constrained to what a language code may look
 * like. It only reaches the master playlist's metadata, never a filename --
 * variants are named by index for exactly that reason -- but it still comes
 * from tags inside an arbitrary media file, so it is not passed through raw.
 */
function languageTagFor(stream: { tags?: Record<string, string> }): string {
  const tag = stream.tags?.language ?? stream.tags?.LANGUAGE ?? '';
  return /^[A-Za-z]{2,3}$/.test(tag) ? tag.toLowerCase() : 'und';
}

/**
 * ffprobe reports frame rates as fractions ("24000/1001" for 23.976), so this
 * cannot just be Number(). Falls back to a sane rate rather than throwing: an
 * unparsable frame rate should cost a slightly-off GOP length, not the job.
 */
function parseFrameRate(rate: string | undefined): number {
  if (!rate) return ASSUMED_FPS;

  const [numerator, denominator] = rate.split('/').map(Number);
  if (!Number.isFinite(numerator) || numerator <= 0) return ASSUMED_FPS;
  if (denominator === undefined) return numerator;
  if (!Number.isFinite(denominator) || denominator <= 0) return ASSUMED_FPS;

  return numerator / denominator;
}
