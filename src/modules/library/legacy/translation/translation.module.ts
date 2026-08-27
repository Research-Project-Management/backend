import { Module } from '@nestjs/common';
import { TranslationController } from './translation.controller';
import { TranslationService } from './translation.service';
import { JobsService as TranslationJobService } from './jobs.service';

import { MetadataModule } from '../metadata/metadata.module';
import { CiteModule } from '../cite/cite.module';
import { ItemsModule } from '../items/items.module';
import { AttachmentsModule } from '../attachments/attachments.module';

@Module({
  imports: [ItemsModule, CiteModule, AttachmentsModule, MetadataModule],
  controllers: [TranslationController],
  providers: [TranslationService, TranslationJobService],
  exports: [TranslationService, TranslationJobService],
})
export class TranslationModule {}
export const IngestionModule = TranslationModule;
export const IngestionService = TranslationService;
export const IngestionController = TranslationController;
export const IngestionJobService = TranslationJobService;
