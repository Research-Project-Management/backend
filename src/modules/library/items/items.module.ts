import { Module } from '@nestjs/common';
import { ItemsController } from './items.controller';
import { ItemsService } from './items.service';
import { ItemsRepository } from './items.repository';
import { ItemsMapper } from './items.mapper';
import { ConversionService } from './conversion.service';
import { TypesModule } from '../types/types.module';
import { CoreModule } from '../../../core/core.module';
import { OutboxModule } from '../outbox/outbox.module';
import { TagsModule } from '../tags/tags.module';
import { CollectionsModule } from '../collections/collections.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { NotesModule } from '../notes/notes.module';
import { ReadingModule } from '../reading/reading.module';
import {
  CATALOG_READ_PORT,
  CATALOG_COMMIT_PORT,
  ITEM_EXISTENCE_PORT,
  ITEM_READ_PORT,
  ITEM_COMMIT_PORT,
} from './items.ports';

@Module({
  imports: [
    CoreModule,
    OutboxModule,
    TagsModule,
    CollectionsModule,
    AttachmentsModule,
    NotesModule,
    ReadingModule,
    TypesModule,
  ],
  controllers: [ItemsController],
  providers: [
    ItemsRepository,
    ItemsService,
    ItemsMapper,
    ConversionService,
    {
      provide: CATALOG_READ_PORT,
      useExisting: ItemsService,
    },
    {
      provide: CATALOG_COMMIT_PORT,
      useExisting: ItemsService,
    },
    {
      provide: ITEM_EXISTENCE_PORT,
      useExisting: ItemsService,
    },
    {
      provide: ITEM_READ_PORT,
      useExisting: ItemsService,
    },
    {
      provide: ITEM_COMMIT_PORT,
      useExisting: ItemsService,
    },
  ],
  exports: [
    ItemsService,
    ItemsMapper,
    ConversionService,
    CATALOG_READ_PORT,
    CATALOG_COMMIT_PORT,
    ITEM_EXISTENCE_PORT,
    ITEM_READ_PORT,
    ITEM_COMMIT_PORT,
  ],
})
export class ItemsModule {}

export const CatalogModule = ItemsModule;
export type CatalogModule = ItemsModule;
