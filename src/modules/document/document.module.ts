import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { NodeModule } from './node/node.module';
import { HistoryModule } from './history/history.module';
import { CompilerModule } from './compiler/compiler.module';
import { CommentModule } from './comment/comment.module';
import { TemplateModule } from './template/template.module';
import { CollaborationModule } from './collaboration/collaboration.module';
import { ExportModule } from './export/export.module';
import { OutlineModule } from './outline/outline.module';
import { AssetModule } from './asset/asset.module';
import { SynctexModule } from './synctex/synctex.module';
import { DocumentFacade, DOCUMENT_FACADE } from './document.facade';

@Module({
  imports: [
    CoreModule,
    NodeModule,
    HistoryModule,
    CompilerModule,
    CommentModule,
    TemplateModule,
    CollaborationModule,
    ExportModule,
    OutlineModule,
    AssetModule,
    SynctexModule,
  ],
  providers: [
    DocumentFacade,
    {
      provide: DOCUMENT_FACADE,
      useClass: DocumentFacade,
    },
  ],
  exports: [
    CoreModule,
    NodeModule,
    DocumentFacade,
    DOCUMENT_FACADE,
    HistoryModule,
    CompilerModule,
    CommentModule,
    TemplateModule,
    CollaborationModule,
    ExportModule,
    OutlineModule,
    AssetModule,
    SynctexModule,
  ],
})
export class DocumentModule {}
