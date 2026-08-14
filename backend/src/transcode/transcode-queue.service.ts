import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { FfprobeService } from '../media/ffprobe.service';
import { directPlayBlockers } from '../common/playability';
import {
  ALLOWED_HEIGHTS,
  AMF_ENCODERS,
  AmfEncoder,
  TRANSCODE_QUEUE,
  TranscodeJobData,
  TranscodeJobInput,
  renditionKey,
} from './transcode.constants';
import { TranscodeProcessor } from './transcode.processor';
import { HlsCleanupService } from './hls-cleanup.service';

export interface BulkTranscodeInput {
  encoder: AmfEncoder;
  /** Renditions are capped at this, and never encoded above the source. */
  maxHeight: number;
  /** Report what would be queued without queueing anything. */
  dryRun: boolean;
  /**
   * Queue at most this many. The whole set is hours of GPU time and hundreds
   * of gigabytes, so it should be possible to take it in batches and look at
   * the result before committing the rest.
   */
  limit?: number;
}

export interface BulkCandidate {
  mediaFileId: string;
  sourcePath: string;
  height: number;
  reason: string;
}

// A row claiming to be in flight while the queue holds no such job is only
// retired once it is this old. The processor removes the job from the queue
// slightly before it writes DONE to the database, and marking a row failed
// inside that window would misreport a job that actually succeeded. Real
// encodes run for minutes; that window is milliseconds.
const ABANDONED_AFTER_MS = 60_000;

@Injectable()
export class TranscodeQueueService {
  private readonly logger = new Logger(TranscodeQueueService.name);

  constructor(
    @InjectQueue(TRANSCODE_QUEUE) private readonly queue: Queue<TranscodeJobData>,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly ffprobe: FfprobeService,
    private readonly processor: TranscodeProcessor,
    private readonly cleanup: HlsCleanupService,
  ) {}

  listRecentJobs() {
    return this.prisma.transcodeJob.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { mediaFile: { select: { sourcePath: true } } },
    });
  }

  async queueStatus() {
    const [queue, database] = await Promise.all([
      this.queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      this.prisma.transcodeJob.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    return { queue, database: Object.fromEntries(database.map((row) => [row.status, row._count._all])) };
  }

  /**
   * Queues a rendition for everything the browser cannot play as it stands.
   *
   * Doing this one file at a time meant 75 hand-written requests, which is
   * why most of the library sat unplayable. Candidates are the files with no
   * direct-play path and no finished rendition; anything already queued is
   * skipped by enqueue() itself.
   */
  async enqueueMissing(input: BulkTranscodeInput) {
    const mediaFiles = await this.prisma.mediaFile.findMany({
      select: {
        id: true,
        sourcePath: true,
        container: true,
        videoCodec: true,
        audioTracks: true,
        transcodeJobs: { where: { status: 'DONE' }, select: { id: true }, take: 1 },
      },
    });

    const mediaRoot = this.config.get<string>('media.root')!;
    const candidates: BulkCandidate[] = [];

    for (const mediaFile of mediaFiles) {
      if (mediaFile.transcodeJobs.length > 0) continue;

      const blockers = directPlayBlockers(mediaFile);
      if (blockers.length === 0) continue;

      candidates.push({
        mediaFileId: mediaFile.id,
        sourcePath: mediaFile.sourcePath,
        // Encoding a 576p DVD rip at 1080p spends disk and GPU on invented
        // detail, so the source height is the ceiling.
        height: await this.renditionHeightFor(
          path.join(mediaRoot, mediaFile.sourcePath),
          input.maxHeight,
        ),
        reason: blockers.join(', '),
      });
    }

    if (input.dryRun) {
      return { candidates, queued: 0, dryRun: true };
    }

    const batch = input.limit ? candidates.slice(0, input.limit) : candidates;
    const queued = [];
    for (const candidate of batch) {
      const job = await this.enqueue({
        mediaFileId: candidate.mediaFileId,
        encoder: input.encoder,
        targetHeight: candidate.height,
      });
      queued.push({ mediaFileId: candidate.mediaFileId, jobId: job.id, height: candidate.height });
    }

    return {
      candidates,
      queued: queued.length,
      remaining: candidates.length - queued.length,
      jobs: queued,
      dryRun: false,
    };
  }

  /**
   * The largest allowed rendition height that neither exceeds the cap nor
   * upscales the source. Falls back to the cap when the source height cannot
   * be read, since a wrong guess there costs a rendition, not the run.
   */
  private async renditionHeightFor(sourcePath: string, maxHeight: number): Promise<number> {
    let sourceHeight = Number.POSITIVE_INFINITY;
    try {
      const probe = await this.ffprobe.probe(sourcePath);
      const video = probe.streams.find((stream) => stream.codec_type === 'video');
      if (video?.height) sourceHeight = video.height;
    } catch {
      this.logger.warn(`Could not probe ${sourcePath}; using the requested height`);
    }

    const ceiling = Math.min(maxHeight, sourceHeight);
    const fitting = ALLOWED_HEIGHTS.filter((height) => height <= ceiling);
    // Nothing fits only when the source is smaller than the smallest rung, in
    // which case the smallest is still the closest thing to "as-is".
    return fitting.length > 0 ? Math.max(...fitting) : ALLOWED_HEIGHTS[0];
  }

  /** Rejects input that would otherwise only fail deep inside ffmpeg. */
  validate(input: Partial<TranscodeJobInput>): TranscodeJobInput {
    if (!input.mediaFileId || typeof input.mediaFileId !== 'string') {
      throw new BadRequestException('mediaFileId is required');
    }
    if (!AMF_ENCODERS.includes(input.encoder as AmfEncoder)) {
      throw new BadRequestException(`encoder must be one of: ${AMF_ENCODERS.join(', ')}`);
    }
    if (!ALLOWED_HEIGHTS.includes(input.targetHeight as number)) {
      throw new BadRequestException(
        `targetHeight must be one of: ${ALLOWED_HEIGHTS.join(', ')}`,
      );
    }
    return input as TranscodeJobInput;
  }

  /**
   * Queues a rendition, or returns the job already producing it.
   *
   * Two ffmpeg processes writing one output directory interleave their
   * segments and corrupt both playlists, which has happened in practice. The
   * directory is keyed on media file and height alone, so the check ignores
   * the encoder on purpose -- see `renditionKey`.
   */
  async enqueue(input: TranscodeJobInput) {
    const key = renditionKey(input.mediaFileId, input.targetHeight);

    const active = await this.prisma.transcodeJob.findFirst({
      where: {
        mediaFileId: input.mediaFileId,
        targetHeight: input.targetHeight,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (active) {
      const queued = await this.queue.getJob(key);
      if (queued) {
        this.logger.log(`${key} is already ${active.status}; reusing job ${active.id}`);
        return active;
      }

      // The row exists but no queue entry backs it yet. Returning it here
      // would be a guess: a concurrent request may be mid-enqueue and about to
      // lose the race, in which case it deletes this very row and the caller
      // is left holding a dead id. So fall through and let the queue settle
      // ownership -- if that other request wins, our add below is rejected and
      // we report its job; if it crashed before enqueueing, we take the slot
      // and it cleans up after itself.
      const age = Date.now() - (active.startedAt ?? active.createdAt).getTime();
      if (age >= ABANDONED_AFTER_MS) {
        this.logger.warn(`${key}: retiring abandoned ${active.status} job ${active.id}`);
        await this.prisma.transcodeJob.update({
          where: { id: active.id },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            error: 'Abandoned: no matching queue entry',
          },
        });
      }
    }

    const job = await this.prisma.transcodeJob.create({
      data: {
        mediaFileId: input.mediaFileId,
        encoder: input.encoder,
        fallbackFrom: input.fallbackFrom,
        attempt: input.attempt ?? 1,
        targetHeight: input.targetHeight,
        status: 'QUEUED',
      },
    });

    await this.queue.add(
      'transcode',
      { ...input, transcodeJobId: job.id },
      // The fixed id makes Redis itself reject a duplicate, closing the gap
      // between the check above and this call. It is released when the job
      // completes, so the rendition can be built again later.
      { jobId: key, attempts: 1, removeOnComplete: true, removeOnFail: false },
    );

    // add() echoes back whatever it was handed, so it cannot report who won a
    // race. The stored job is the authority on that.
    const owner = await this.queue.getJob(key);
    if (owner && owner.data.transcodeJobId !== job.id) {
      this.logger.warn(`${key}: lost the race, dropping duplicate row ${job.id}`);
      await this.prisma.transcodeJob.delete({ where: { id: job.id } });
      return this.prisma.transcodeJob.findUniqueOrThrow({
        where: { id: owner.data.transcodeJobId },
      });
    }

    return job;
  }

  async cancel(jobId: string) {
    const job = await this.getJob(jobId);
    if (!['QUEUED', 'RUNNING'].includes(job.status)) {
      throw new ConflictException(`Only queued or running jobs can be cancelled; job is ${job.status}`);
    }
    await this.prisma.transcodeJob.update({
      where: { id: job.id },
      data: {
        status: 'CANCELLED',
        cancelRequestedAt: new Date(),
        finishedAt: new Date(),
        error: 'Cancelled by administrator',
      },
    });
    const queueJob = await this.queue.getJob(renditionKey(job.mediaFileId, job.targetHeight));
    if (queueJob) {
      const state = await queueJob.getState();
      if (state === 'active') await this.processor.cancelJob(job.id);
      else await queueJob.remove();
    }
    await this.cleanup.discardWork(job.mediaFileId, job.targetHeight, job.id);
    return this.getJob(job.id);
  }

  async retry(jobId: string) {
    const job = await this.getJob(jobId);
    if (!['FAILED', 'CANCELLED'].includes(job.status)) {
      throw new ConflictException(`Only failed or cancelled jobs can be retried; job is ${job.status}`);
    }
    await this.releaseQueueSlot(job.mediaFileId, job.targetHeight);
    return this.enqueue({
      mediaFileId: job.mediaFileId,
      encoder: job.encoder as TranscodeJobInput['encoder'],
      targetHeight: job.targetHeight,
      attempt: job.attempt + 1,
      fallbackFrom: job.fallbackFrom as TranscodeJobInput['fallbackFrom'],
    });
  }

  async requeue(jobId: string) {
    const job = await this.getJob(jobId);
    if (['QUEUED', 'RUNNING'].includes(job.status)) {
      throw new ConflictException('Cancel an active job before requeueing it');
    }
    await this.releaseQueueSlot(job.mediaFileId, job.targetHeight);
    await this.cleanup.removeRendition(job.mediaFileId, job.targetHeight);
    const encoder = (job.fallbackFrom ?? job.encoder) as TranscodeJobInput['encoder'];
    return this.enqueue({
      mediaFileId: job.mediaFileId,
      encoder,
      targetHeight: job.targetHeight,
      attempt: job.attempt + 1,
    });
  }

  private async getJob(jobId: string) {
    const job = await this.prisma.transcodeJob.findUnique({
      where: { id: jobId },
      include: { mediaFile: { select: { sourcePath: true } } },
    });
    if (!job) throw new NotFoundException(`Transcode job ${jobId} not found`);
    return job;
  }

  private async releaseQueueSlot(mediaFileId: string, targetHeight: number) {
    const queued = await this.queue.getJob(renditionKey(mediaFileId, targetHeight));
    if (!queued) return;
    if ((await queued.getState()) === 'active') throw new ConflictException('The queue slot is still active');
    await queued.remove();
  }
}
