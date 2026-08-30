import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogCurationController } from './catalog-curation.controller';
import { CatalogService } from './catalog.service';
import { CatalogRepository } from './catalog.repository';
import { CoreModule } from '../../../core/core.module';
import { SyncModule } from '../sync/sync.module';

@Module({
  imports: [CoreModule, SyncModule],
  controllers: [CatalogController, CatalogCurationController],
  providers: [CatalogRepository, CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
