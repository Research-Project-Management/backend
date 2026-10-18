import { Module, Global } from '@nestjs/common';
import { STORAGE_PORT } from './storage.tokens';

import { StorageCoreModule } from './core/core.module';
import { StorageDriveModule } from './drive/drive.module';
import { StorageTransferModule } from './transfer/transfer.module';
import { StorageWorkerModule } from './worker/worker.module';

import { StorageFacade } from './storage.facade';

@Global()
@Module({
  imports: [
    StorageCoreModule,
    StorageDriveModule,
    StorageTransferModule,
    StorageWorkerModule,
  ],
  providers: [
    StorageFacade,
    {
      provide: STORAGE_PORT,
      useExisting: StorageFacade,
    },
  ],
  exports: [
    StorageCoreModule,
    StorageDriveModule,
    StorageTransferModule,
    StorageWorkerModule,
    StorageFacade,
    STORAGE_PORT,
  ],
})
export class StorageModule {}
