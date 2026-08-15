import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { MediaModule } from './media/media.module';
import { TranscodeModule } from './transcode/transcode.module';
import { CatalogModule } from './catalog/catalog.module';
import { AuthModule } from './auth/auth.module';
import { ProfilesModule } from './profiles/profiles.module';
import { PlaybackModule } from './playback/playback.module';
import { SubtitlesModule } from './subtitles/subtitles.module';
import { StreamModule } from './stream/stream.module';
import { MetadataModule } from './metadata/metadata.module';
import { HealthController } from './health.controller';
import { AuditMiddleware } from './monitoring/audit.middleware';
import { AdminModule } from './admin/admin.module';
import { RateLimitMiddleware } from './monitoring/rate-limit.middleware';
import { DevicePairingModule } from './device-pairing/device-pairing.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.get<string>('redis.url') },
      }),
      inject: [ConfigService],
    }),
    PrismaModule,
    MediaModule,
    TranscodeModule,
    CatalogModule,
    AuthModule,
    ProfilesModule,
    PlaybackModule,
    SubtitlesModule,
    StreamModule,
    MetadataModule,
    AdminModule,
    DevicePairingModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RateLimitMiddleware, AuditMiddleware).forRoutes('*');
  }
}
