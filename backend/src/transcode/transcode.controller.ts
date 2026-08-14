import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { TranscodeQueueService } from './transcode-queue.service';
import { ALLOWED_HEIGHTS, AMF_ENCODERS, AmfEncoder, TranscodeJobInput } from './transcode.constants';

interface BulkBody {
  encoder?: string;
  maxHeight?: number;
  dryRun?: boolean;
  limit?: number;
}

// Queuing a transcode occupies the GPU for minutes at a time, so this cannot
// stay open to anyone who can reach the port.
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('transcode')
export class TranscodeController {
  constructor(private readonly queue: TranscodeQueueService) {}

  @Get('jobs')
  jobs() {
    return this.queue.listRecentJobs();
  }

  @Get('status')
  status() {
    return this.queue.queueStatus();
  }

  @Post()
  async enqueue(@Body() body: Partial<TranscodeJobInput>) {
    return this.queue.enqueue(this.queue.validate(body));
  }

  @Post('jobs/:jobId/cancel')
  cancel(@Param('jobId') jobId: string) {
    return this.queue.cancel(jobId);
  }

  @Post('jobs/:jobId/retry')
  retry(@Param('jobId') jobId: string) {
    return this.queue.retry(jobId);
  }

  @Post('jobs/:jobId/requeue')
  requeue(@Param('jobId') jobId: string) {
    return this.queue.requeue(jobId);
  }

  /**
   * Queues renditions for everything that cannot be played as it stands.
   *
   * Defaults to a dry run: this can commit the GPU for hours and hundreds of
   * gigabytes, so seeing the list has to be the easy path and starting the
   * work has to be deliberate.
   */
  @Post('missing')
  async enqueueMissing(@Body() body: BulkBody) {
    const encoder = (body.encoder ?? 'h264_amf') as AmfEncoder;
    if (!AMF_ENCODERS.includes(encoder)) {
      throw new BadRequestException(`encoder must be one of: ${AMF_ENCODERS.join(', ')}`);
    }

    const maxHeight = body.maxHeight ?? 720;
    if (!ALLOWED_HEIGHTS.includes(maxHeight)) {
      throw new BadRequestException(`maxHeight must be one of: ${ALLOWED_HEIGHTS.join(', ')}`);
    }

    if (body.limit !== undefined && (!Number.isInteger(body.limit) || body.limit < 1)) {
      throw new BadRequestException('limit must be a positive integer');
    }

    return this.queue.enqueueMissing({
      encoder,
      maxHeight,
      // Defaults to a dry run: starting hours of encoding must be the
      // deliberate choice, not the one you get by forgetting a flag.
      dryRun: body.dryRun !== false,
      limit: body.limit,
    });
  }
}
