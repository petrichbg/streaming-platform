import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';

@Module({
  imports: [AuthModule],
  controllers: [ProfilesController],
  providers: [ProfilesService],
  // Exported so PlaybackModule can reuse findOneForUser() for its
  // profile-ownership checks instead of duplicating that logic.
  exports: [ProfilesService],
})
export class ProfilesModule {}
