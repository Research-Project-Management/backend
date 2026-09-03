import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { ItemTypesController } from './item-types.controller';
import { CatalogService } from './catalog.service';
import { CatalogRepository } from './catalog.repository';
import { ItemTypeRegistryService } from './registry/item-type-registry.service';
import { MetadataCompletenessService } from './services/metadata-completeness.service';
import { ItemTypeConversionService } from './services/item-type-conversion.service';
import { CoreModule } from '../../../core/core.module';
import { SyncModule } from '../sync/sync.module';
import {
  CATALOG_READ_PORT,
  CATALOG_COMMIT_PORT,
  ITEM_EXISTENCE_PORT,
} from './ports/catalog.ports';

@Module({
  imports: [CoreModule, SyncModule],
  controllers: [CatalogController, ItemTypesController],
  providers: [
    CatalogRepository,
    CatalogService,
    ItemTypeRegistryService,
    MetadataCompletenessService,
    ItemTypeConversionService,
    {
      provide: CATALOG_READ_PORT,
      useExisting: CatalogService,
    },
    {
      provide: CATALOG_COMMIT_PORT,
      useExisting: CatalogService,
    },
    {
      provide: ITEM_EXISTENCE_PORT,
      useExisting: CatalogService,
    },
  ],
  exports: [
    CatalogService,
    ItemTypeRegistryService,
    MetadataCompletenessService,
    ItemTypeConversionService,
    CATALOG_READ_PORT,
    CATALOG_COMMIT_PORT,
    ITEM_EXISTENCE_PORT,
  ],
})
export class CatalogModule {}
