/**
 * modules/pages/page/page.module.ts
 * Complete NestJS Module for Page aggregate management (CRUD, content OCC,
 * files, trash/restore, duplication, labels, scaffolding, and cleanup).
 */

import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { FilesModule } from '@/modules/files/files.module';
import { FilestoreModule } from '@/modules/pages/filestore';
import { DocstoreModule } from '../docstore/docstore.module';
import { PageController } from './page.controller';
import { PageRepository } from './page.repository';
import { PageContentService } from './services/content.service';
import { PageDuplicateService } from './services/duplicate.service';
import { PageFileService } from './services/file.service';
import { PageLabelsService } from './services/labels.service';
import { PageService } from './services/page.service';
import { PageQueryService } from './services/query.service';
import { PageScaffoldService } from './services/scaffold.service';
import { PageTrashService } from './services/trash.service';
import { CleanupListener } from './listeners/cleanup.listener';

@Module({
  imports: [
    PrismaModule,
    FilesModule,
    FilestoreModule,
    forwardRef(() => DocstoreModule),
  ],
  controllers: [PageController],
  providers: [
    PageRepository,
    PageQueryService,
    PageContentService,
    PageFileService,
    PageTrashService,
    PageDuplicateService,
    PageLabelsService,
    PageScaffoldService,
    PageService,
    CleanupListener,
  ],
  exports: [PageService, PageScaffoldService],
})
export class PageModule {}
