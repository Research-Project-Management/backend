/**
 * modules/pages/bootstrap/editor-bootstrap.module.ts
 * Root-level Pages BFF bootstrap module composing Docstore, Structure, and Clsi seams.
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { PagesCoreModule } from '@/modules/pages/core';
import { DocstoreModule } from '@/modules/pages/docstore';
import { PageModule } from '@/modules/pages/page';
import { StructureModule } from '@/modules/pages/structure';
import { ClsiModule } from '@/modules/pages/clsi';
import { EditorBootstrapService } from './editor-bootstrap.service';

@Module({
  imports: [
    PrismaModule,
    PagesCoreModule,
    DocstoreModule,
    PageModule,
    StructureModule,
    ClsiModule,
  ],
  providers: [EditorBootstrapService],
  exports: [EditorBootstrapService],
})
export class EditorBootstrapModule {}
