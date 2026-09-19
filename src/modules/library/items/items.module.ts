import { Module } from '@nestjs/common';
import { ItemsController } from './items.controller';
import { ItemsService } from './items.service';
import { QueryRepository } from './repositories/query.repository';
import { CommandRepository } from './repositories/command.repository';
import { ItemsMapper } from './mappers/items.mapper';
import { ItemTransformer } from './transformers/item.transformer';
import { CoreModule } from '../../../core/core.module';
import { OutboxModule } from '../outbox/outbox.module';
import { TagsModule } from '../tags/tags.module';
import { SearchModule } from '../search/search.module';
import { TypesModule } from '../types/types.module';
import { ITEM_EXISTENCE_PORT, ITEM_READ_PORT } from './ports/items.ports';
import { InfraModule } from '../infra/infra.module';

@Module({
  imports: [
    CoreModule,
    InfraModule,
    OutboxModule,
    TagsModule,
    SearchModule,
    TypesModule,
  ],
  controllers: [ItemsController],
  providers: [
    QueryRepository,
    CommandRepository,
    ItemsService,
    ItemsMapper,
    ItemTransformer,
    {
      provide: ITEM_EXISTENCE_PORT,
      useExisting: ItemsService,
    },
    {
      provide: ITEM_READ_PORT,
      useExisting: ItemsService,
    },
  ],
  exports: [
    ItemsService,
    QueryRepository,
    CommandRepository,
    ItemsMapper,
    ItemTransformer,
    ITEM_EXISTENCE_PORT,
    ITEM_READ_PORT,
  ],
})
export class ItemsModule {}
