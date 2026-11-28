/**
 * modules/pages/page/page.module.ts
 * Complete NestJS Module for Page aggregate management (CRUD, content OCC,
 * files, trash/restore, duplication, labels, scaffolding, and cleanup).
 */

import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { FilesModule } from '@/modules/files/files.module';
import { FilestoreModule } from '../filestore/filestore.module';
import { DocstoreModule } from '../docstore/docstore.module';
import { PageController } from './page.controller';
import { PageRepository } from './page.repository';
import { PageService } from './services/page.service';
import { PageScaffoldService } from './services/scaffold.service';
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
    PageService,
    PageScaffoldService,
    CleanupListener,
  ],
  exports: [PageRepository, PageService, PageScaffoldService],
})
export class PageModule {}
