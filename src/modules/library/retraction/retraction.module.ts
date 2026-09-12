import { Module } from '@nestjs/common';
import { RetractionController } from './retraction.controller';
import { RetractionService } from './retraction.service';
import { RetractionRepository } from './retraction.repository';
import { RetractionScannerProvider } from './providers/retraction-scanner.provider';
import { CoreModule } from '../../../core/core.module';

@Module({
  imports: [CoreModule],
  controllers: [RetractionController],
  providers: [
    RetractionService,
    RetractionRepository,
    RetractionScannerProvider,
  ],
  exports: [RetractionService, RetractionRepository, RetractionScannerProvider],
})
export class RetractionModule {}
