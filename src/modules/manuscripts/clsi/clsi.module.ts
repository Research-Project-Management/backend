/**
 * modules/manuscripts/clsi/clsi.module.ts
 * NestJS Module bundling CLSI controllers and providers
 */

import { Module } from '@nestjs/common';
import { CoreModule as AppCoreModule } from '@/core/core.module';
import { ClsiController } from './clsi.controller';
import { ClsiService } from './clsi.service';

@Module({
  imports: [AppCoreModule],
  controllers: [ClsiController],
  providers: [ClsiService],
  exports: [ClsiService],
})
export class ClsiModule {}
