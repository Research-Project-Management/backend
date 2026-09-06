import { Module } from '@nestjs/common';
import { ItemsController } from './items.controller';
import { ItemsService, CatalogService } from './items.service';
import { ItemsRepository } from './items.repository';
import { ItemQueryRepository } from './repositories/item-query.repository';
import { ItemCommandRepository } from './repositories/item-command.repository';
import { ItemsMapper } from './mappers/items.mapper';
import { CoreModule } from '../../../core/core.module';
import { TypesModule } from '../types/types.module';
import { OutboxModule } from '../outbox/outbox.module';
import { TagsModule } from '../tags/tags.module';
import { CollectionsModule } from '../collections/collections.module';
import { SearchModule } from '../search/search.module';
import {
  CATALOG_READ_PORT,
  CATALOG_COMMIT_PORT,
  ITEM_EXISTENCE_PORT,
  ITEM_READ_PORT,
  ITEM_COMMIT_PORT,
} from './ports/items.ports';

@Module({
  imports: [
    CoreModule,
    OutboxModule,
    TagsModule,
    TypesModule,
    CollectionsModule,
    SearchModule,
  ],
  controllers: [ItemsController],
  providers: [
    ItemQueryRepository,
    ItemCommandRepository,
    ItemsRepository,
    ItemsService,
    ItemsMapper,
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
    CatalogService,
    ItemsMapper,
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
