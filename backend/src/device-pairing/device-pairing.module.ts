import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DevicePairingController } from './device-pairing.controller';
import { DevicePairingService } from './device-pairing.service';

@Module({ imports: [AuthModule], controllers: [DevicePairingController], providers: [DevicePairingService] })
export class DevicePairingModule {}
