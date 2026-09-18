import { Module } from '@nestjs/common';
import { RetractionController } from './retraction.controller';
import { RetractionService } from './retraction.service';
import { RetractionRepository } from './retraction.repository';
import { RetractionScannerProvider } from './providers/retraction-scanner.provider';
import { RetractionDatabaseService } from './services/retraction-database.service';
import { RetractionSyncService } from './services/retraction-sync.service';
import { CoreModule } from '../../../core/core.module';

@Module({
  imports: [CoreModule],
  controllers: [RetractionController],
  providers: [
    RetractionService,
    RetractionRepository,
    RetractionDatabaseService,
    RetractionScannerProvider,
    RetractionSyncService,
  ],
  exports: [
    RetractionService,
    RetractionRepository,
    RetractionDatabaseService,
    RetractionScannerProvider,
    RetractionSyncService,
  ],
})
export class RetractionModule {}
