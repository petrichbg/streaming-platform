import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProfilesModule } from '../profiles/profiles.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { ContentAccessService } from './content-access.service';

@Module({
  // AuthModule for JwtAuthGuard, ProfilesModule to resolve the viewing
  // profile's parental-control cap.
  imports: [AuthModule, ProfilesModule],
  controllers: [CatalogController],
  providers: [CatalogService, ContentAccessService],
  // The media, stream and subtitle modules enforce the same cap on the
  // content itself, so the check lives here next to the rating ladders.
  exports: [ContentAccessService],
})
export class CatalogModule {}
