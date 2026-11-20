import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { DocstoreModule } from '@/modules/pages/docstore/docstore.module';
import { CommentsController } from './controllers/comments.controller';
import { ReviewStatusController } from './controllers/status.controller';
import { SuggestionsController } from './controllers/suggestions.controller';
import { DocPatcher } from './doc-patcher.adapter';
import { ReviewRepository } from './review.repository';
import { CommentsService } from './services/comments.service';
import { ReviewStatusService } from './services/status.service';
import { SuggestionsService } from './services/suggestions.service';

@Module({
  imports: [PrismaModule, DocstoreModule],
  controllers: [
    CommentsController,
    SuggestionsController,
    ReviewStatusController,
  ],
  providers: [
    ReviewRepository,
    DocPatcher,
    CommentsService,
    SuggestionsService,
    ReviewStatusService,
  ],
  exports: [
    ReviewRepository,
    DocPatcher,
    CommentsService,
    SuggestionsService,
    ReviewStatusService,
  ],
})
export class ReviewModule {}
