import { Module, forwardRef } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { CatalogRepository } from './catalog.repository';
import { CatalogExtraStore } from './catalog-extra.store';
import { FileModule } from '@/modules/storage/file/file.module';
import { CitationModule } from '../citation/citation.module';
import { IngestionModule } from '../ingestion/ingestion.module';

@Module({
  imports: [
    FileModule,
    forwardRef(() => CitationModule),
    forwardRef(() => IngestionModule),
  ],
  controllers: [CatalogController],
  providers: [CatalogService, CatalogRepository, CatalogExtraStore],
  exports: [CatalogService, CatalogRepository, CatalogExtraStore],
})
export class CatalogModule {}
