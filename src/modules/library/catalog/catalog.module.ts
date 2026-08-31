import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogCurationController } from './catalog-curation.controller';
import { CatalogService } from './catalog.service';
import { CatalogRepository } from './catalog.repository';
import { CoreModule } from '../../../core/core.module';
import { SyncModule } from '../sync/sync.module';
import { CATALOG_READ_PORT } from './ports/catalog-read.port';
import { CATALOG_COMMIT_PORT } from './ports/catalog-commit.port';
import { ITEM_EXISTENCE_PORT } from './ports/item-existence.port';

@Module({
  imports: [CoreModule, SyncModule],
  controllers: [CatalogController, CatalogCurationController],
  providers: [
    CatalogRepository,
    CatalogService,
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
    CATALOG_READ_PORT,
    CATALOG_COMMIT_PORT,
    ITEM_EXISTENCE_PORT,
  ],
})
export class CatalogModule {}
