import { Module } from '@nestjs/common';
import { PageModule } from './page/page.module';
import { TreeModule } from './tree/tree.module';
import { HistoryModule } from './history/history.module';
import { CompilerModule } from './compiler/compiler.module';
import { CommentModule } from './comment/comment.module';
import { TemplateModule } from './template/template.module';
import { CollaborationModule } from './collaboration/collaboration.module';
import { ExportModule } from './export/export.module';
import { AssetModule } from './asset/asset.module';
import { SuggestionModule } from './suggestion/suggestion.module';
import { NotificationBundlerModule } from './notification/notification-bundler.module';
import { OutlineModule } from './outline/outline.module';
import { SearchModule } from './search/search.module';
import { DocumentFacade, DOCUMENT_FACADE } from './document.facade';

@Module({
  imports: [
    PageModule,
    TreeModule,
    HistoryModule,
    CompilerModule,
    CommentModule,
    TemplateModule,
    CollaborationModule,
    ExportModule,
    AssetModule,
    SuggestionModule,
    NotificationBundlerModule,
    OutlineModule,
    SearchModule,
  ],
  providers: [
    DocumentFacade,
    {
      provide: DOCUMENT_FACADE,
      useClass: DocumentFacade,
    },
  ],
  exports: [
    PageModule,
    TreeModule,
    DocumentFacade,
    DOCUMENT_FACADE,
    HistoryModule,
    CompilerModule,
    CommentModule,
    TemplateModule,
    CollaborationModule,
    ExportModule,
    AssetModule,
    SuggestionModule,
    NotificationBundlerModule,
    OutlineModule,
    SearchModule,
  ],
})
export class DocumentModule {}
