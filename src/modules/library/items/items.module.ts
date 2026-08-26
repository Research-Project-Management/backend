import { Module } from '@nestjs/common';
import { ItemsController } from './items.controller';
import { ItemsService } from './items.service';
import { ItemsRepository } from './items.repository';
import { FileModule } from '@/modules/storage/file/file.module';

@Module({
  imports: [FileModule],
  controllers: [ItemsController],
  providers: [ItemsService, ItemsRepository],
  exports: [ItemsService, ItemsRepository],
})
export class ItemsModule {}
export const CatalogModule = ItemsModule;
export const ItemsRepositoryToken = ItemsRepository;
