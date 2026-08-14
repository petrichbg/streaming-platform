import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CatalogModule } from '../catalog/catalog.module';
import { SubtitlesController } from './subtitles.controller';
import { SubtitlesService } from './subtitles.service';

@Module({
  imports: [AuthModule, CatalogModule],
  controllers: [SubtitlesController],
  providers: [SubtitlesService],
})
export class SubtitlesModule {}
