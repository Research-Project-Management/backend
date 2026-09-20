import { Module } from '@nestjs/common';
import { PageController } from './page.controller';
import { PageService } from './page.service';
import { PageRepository } from './page.repository';
import { DocumentFacade, DOCUMENT_FACADE } from '../document.facade';
import { TreeModule } from '../tree/tree.module';
import { CoreModule as AppCoreModule } from '@/core/core.module';

@Module({
  imports: [AppCoreModule, TreeModule],
  controllers: [PageController],
  providers: [
    PageService,
    PageRepository,
    DocumentFacade,
    {
      provide: DOCUMENT_FACADE,
      useClass: DocumentFacade,
    },
  ],
  exports: [PageService, PageRepository, DocumentFacade, DOCUMENT_FACADE],
})
export class PageModule {}
