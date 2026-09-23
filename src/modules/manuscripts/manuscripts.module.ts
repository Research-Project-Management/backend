/**
 * modules/manuscripts/manuscripts.module.ts
 * Root NestJS Module for Manuscripts subsystem (Overleaf-parity architecture)
 */

import { Module } from '@nestjs/common';
import { ClsiModule } from './clsi/clsi.module';

@Module({
  imports: [ClsiModule],
  exports: [ClsiModule],
})
export class ManuscriptsModule {}
