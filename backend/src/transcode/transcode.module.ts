import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TRANSCODE_QUEUE } from './transcode.constants';
import { TranscodeQueueService } from './transcode-queue.service';
import { TranscodeController } from './transcode.controller';
import { TranscodeProcessor } from './transcode.processor';
import { AuthModule } from '../auth/auth.module';
import { MediaModule } from '../media/media.module';
import { HlsCleanupService } from './hls-cleanup.service';

@Module({
  // AuthModule is for JwtAuthGuard on POST /transcode.
  imports: [BullModule.registerQueue({ name: TRANSCODE_QUEUE }), AuthModule, MediaModule],
  controllers: [TranscodeController],
  providers: [TranscodeQueueService, TranscodeProcessor, HlsCleanupService],
  exports: [TranscodeQueueService],
})
export class TranscodeModule {}
