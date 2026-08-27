import { Module } from '@nestjs/common';
import { PageModule } from './page/page.module';
import { HistoryModule } from './history/history.module';
import { LatexModule } from './latex/latex.module';
import { EngineModule } from './engine/engine.module';
import { PageCommentModule } from './comment/comment.module';

@Module({
  imports: [
    PageModule,
    HistoryModule,
    LatexModule,
    EngineModule,
    PageCommentModule,
  ],
  exports: [
    PageModule,
    HistoryModule,
    LatexModule,
    EngineModule,
    PageCommentModule,
  ],
})
export class DocumentModule {}
