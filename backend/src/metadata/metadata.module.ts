import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MetadataController } from './metadata.controller';
import { MetadataService } from './metadata.service';
import { TmdbService } from './tmdb.service';

@Module({
  imports: [AuthModule],
  controllers: [MetadataController],
  providers: [MetadataService, TmdbService],
  exports: [MetadataService],
})
export class MetadataModule {}
