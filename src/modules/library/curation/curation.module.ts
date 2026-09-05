import { Module } from '@nestjs/common';
import { CurationController } from './curation.controller';
import { DuplicateService } from './duplicate.service';
import { QualityService } from './quality.service';
import { CoreModule } from '../../../core/core.module';
import { ItemsModule } from '../items/items.module';
import { TypesModule } from '../types/types.module';
import { TagsModule } from '../tags/tags.module';
import { CollectionsModule } from '../collections/collections.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { NotesModule } from '../notes/notes.module';
import { ReadingModule } from '../reading/reading.module';
import { OutboxModule } from '../outbox/outbox.module';

@Module({
  imports: [
    CoreModule,
    ItemsModule,
    OutboxModule,
    TypesModule,
    TagsModule,
    CollectionsModule,
    AttachmentsModule,
    NotesModule,
    ReadingModule,
  ],
  controllers: [CurationController],
  providers: [DuplicateService, QualityService],
  exports: [DuplicateService, QualityService],
})
export class CurationModule {}
