import { Module } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { ItemsModule } from '../items/items.module';
import { CoreModule } from '../../../core/core.module';
import { SyncCoreContextModule } from '../../../contexts/library/sync-core/sync-core.module';

@Module({
  imports: [ItemsModule, CoreModule, SyncCoreContextModule],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
