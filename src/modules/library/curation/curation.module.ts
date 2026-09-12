import { Module } from '@nestjs/common';
import { CurationController } from './curation.controller';
import { DuplicateService } from './services/duplicate.service';
import { QualityService } from './services/quality.service';
import { CoreModule } from '../../../core/core.module';
import { ItemsModule } from '../items/items.module';
import { TagsModule } from '../tags/tags.module';
import { CollectionsModule } from '../collections/collections.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { NotesModule } from '../notes/notes.module';
import { OutboxModule } from '../outbox/outbox.module';

import { StateModule } from '../state/state.module';
import { TypesModule } from '../types/types.module';

@Module({
  imports: [
    CoreModule,
    ItemsModule,
    OutboxModule,
    TagsModule,
    CollectionsModule,
    AttachmentsModule,
    NotesModule,
    StateModule,
    TypesModule,
  ],
  controllers: [CurationController],
  providers: [DuplicateService, QualityService],
  exports: [DuplicateService, QualityService],
})
export class CurationModule {}
