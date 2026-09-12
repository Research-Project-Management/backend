import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { PageModule } from './page/page.module';
import { HistoryModule } from './history/history.module';
import { LatexModule } from './latex/latex.module';
import { EngineModule } from './engine/engine.module';
import { CommentModule } from './comment/comment.module';
import { DocumentFacade, DOCUMENT_FACADE } from './core/document.facade';

@Module({
  imports: [
    CoreModule,
    PageModule,
    HistoryModule,
    LatexModule,
    EngineModule,
    CommentModule,
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
    PageModule,
    DocumentFacade,
    DOCUMENT_FACADE,
    HistoryModule,
    LatexModule,
    EngineModule,
    CommentModule,
  ],
})
export class DocumentModule {}
