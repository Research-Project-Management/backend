/**
 * document-updater/document-updater.module.ts
 * NestJS Module for Manuscripts Document Updater subsystem.
 */

import { Module } from '@nestjs/common';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';
import { DocumentUpdaterController } from './document-updater.controller';
import { DocumentUpdaterService } from './document-updater.service';
import { DocumentUpdaterRepository } from './document-updater.repository';
import { IInFlightStorePort } from './domain';

@Module({
  imports: [DocstoreModule],
  controllers: [DocumentUpdaterController],
  providers: [
    DocumentUpdaterRepository,
    DocumentUpdaterService,
    {
      provide: IInFlightStorePort,
      useExisting: DocumentUpdaterRepository,
    },
  ],
  exports: [
    DocumentUpdaterService,
    DocumentUpdaterRepository,
    IInFlightStorePort,
  ],
})
export class DocumentUpdaterModule {}
