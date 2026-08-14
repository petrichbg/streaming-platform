import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CatalogModule } from '../catalog/catalog.module';
import { StreamController } from './stream.controller';
import { StreamService } from './stream.service';

@Module({
  // CatalogModule supplies ContentAccessService — the parental-control cap
  // applies to the bytes, not only to the catalog that lists them.
  imports: [AuthModule, CatalogModule],
  controllers: [StreamController],
  providers: [StreamService],
})
export class StreamModule {}
