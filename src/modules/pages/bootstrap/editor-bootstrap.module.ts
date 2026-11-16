/**
 * modules/pages/bootstrap/editor-bootstrap.module.ts
 * Root-level Pages BFF bootstrap module composing Docstore, Structure, and Clsi seams.
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { ManuscriptsCoreModule } from '@/modules/pages/core/core.module';
import { DocstoreModule } from '@/modules/pages/docstore/docstore.module';
import { StructureModule } from '@/modules/pages/structure/structure.module';
import { ClsiModule } from '@/modules/pages/clsi/clsi.module';
import { EditorBootstrapController } from './editor-bootstrap.controller';
import { EditorBootstrapService } from './editor-bootstrap.service';

@Module({
  imports: [
    PrismaModule,
    ManuscriptsCoreModule,
    DocstoreModule,
    StructureModule,
    ClsiModule,
  ],
  controllers: [EditorBootstrapController],
  providers: [EditorBootstrapService],
  exports: [EditorBootstrapService],
})
export class EditorBootstrapModule {}
