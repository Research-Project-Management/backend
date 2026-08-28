import { Module } from '@nestjs/common';
import { CoreModule } from '../../core/core.module';
import { ZoteroModule } from './zotero/zotero.module';

@Module({
  imports: [CoreModule, ZoteroModule],
  exports: [ZoteroModule],
})
export class IntegrationsModule {}
