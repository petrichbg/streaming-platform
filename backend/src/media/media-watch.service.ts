import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaScannerService } from './media-scanner.service';

@Injectable()
export class MediaWatchService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MediaWatchService.name);
  private timer?: NodeJS.Timeout;
  constructor(private readonly scanner: MediaScannerService, private readonly config: ConfigService) {}

  onModuleInit() {
    const interval = Math.max(15_000, this.config.get<number>('media.watchIntervalMs') ?? 60_000);
    this.timer = setInterval(() => void this.scan(), interval);
    this.timer.unref();
    setTimeout(() => void this.scan(), 8_000).unref();
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }
  private async scan() {
    try {
      const result = await this.scanner.scan();
      if (result.imported || result.failed) this.logger.log(`Automatic media scan: imported=${result.imported}, failed=${result.failed}`);
    } catch (error) { this.logger.error(`Automatic media scan failed: ${(error as Error).message}`); }
  }
}
