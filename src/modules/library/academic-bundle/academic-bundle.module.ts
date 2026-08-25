import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { CitationModule } from '../citation/citation.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { AcademicBundleController } from './academic-bundle.controller';
import { AcademicBundleService } from './academic-bundle.service';

@Module({
  imports: [CatalogModule, CitationModule, AttachmentsModule, KnowledgeModule],
  controllers: [AcademicBundleController],
  providers: [AcademicBundleService],
  exports: [AcademicBundleService],
})
export class AcademicBundleModule {}
