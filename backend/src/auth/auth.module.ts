import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('auth.jwtSecret');
        if (!secret) {
          throw new Error(
            'JWT_SECRET is not set in backend/.env — refusing to start without it.',
          );
        }
        const expiresIn = config.get<string>('auth.jwtExpiresIn') ?? '7d';
        if (!/^\d+[smhd]$/.test(expiresIn)) {
          throw new Error('JWT_EXPIRES_IN must use a value such as 15m, 12h, or 7d.');
        }
        return {
          secret,
          signOptions: { expiresIn: expiresIn as `${number}${'s' | 'm' | 'h' | 'd'}` },
        };
      },
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  exports: [JwtAuthGuard, JwtModule],
})
export class AuthModule {}
