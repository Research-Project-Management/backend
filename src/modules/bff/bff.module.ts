/**
 * modules/bff/bff.module.ts
 * Root Backend-for-Frontend (BFF) module.
 *
 * Composes shared BFF infrastructure (BffCoreModule) with channel-specific
 * modules (WebBffModule today; plug in MobileBffModule when mobile launches).
 */

import { Module } from '@nestjs/common';
import { BffCoreModule } from './core/bff-core.module';
import { WebBffModule } from './web/web-bff.module';

@Module({
  imports: [BffCoreModule, WebBffModule],
  exports: [BffCoreModule, WebBffModule],
})
export class BffModule {}
