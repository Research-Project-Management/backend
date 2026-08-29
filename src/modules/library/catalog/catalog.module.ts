import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { CatalogRepository } from './catalog.repository';
import { CoreModule } from '../../../core/core.module';
import { SyncModule } from '../sync/sync.module';
@Module({
  imports: [CoreModule, SyncModule],
  controllers: [CatalogController],
  providers: [CatalogRepository, CatalogService],
  exports: [CatalogRepository, CatalogService],
})
export class CatalogModule {}
