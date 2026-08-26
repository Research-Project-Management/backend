import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { CatalogRepository } from './catalog.repository';
import { CoreModule } from '../../../core/core.module';
import { LibraryFeatureFlagsService } from '../common/library-feature-flags';
import { SyncCoreContextModule } from '../sync-core/sync-core.module';

@Module({
  imports: [CoreModule, SyncCoreContextModule],
  controllers: [CatalogController],
  providers: [CatalogRepository, CatalogService, LibraryFeatureFlagsService],
  exports: [CatalogRepository, CatalogService],
})
export class CatalogContextModule {}
