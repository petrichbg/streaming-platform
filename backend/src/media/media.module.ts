import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CatalogModule } from '../catalog/catalog.module';
import { MediaController } from './media.controller';
import { MediaScannerService } from './media-scanner.service';
import { FfprobeService } from './ffprobe.service';

@Module({
  // AuthModule for JwtAuthGuard on GET /media/:mediaFileId, CatalogModule for
  // the parental-control check on the same route.
  imports: [AuthModule, CatalogModule],
  controllers: [MediaController],
  providers: [MediaScannerService, FfprobeService],
  exports: [MediaScannerService, FfprobeService],
})
export class MediaModule {}
