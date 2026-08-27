import { Module } from '@nestjs/common';
import { PageCommentController } from './comment.controller';
import { PageCommentService } from './comment.service';
import { PageCommentRepository } from './comment.repository';

@Module({
  controllers: [PageCommentController],
  providers: [PageCommentService, PageCommentRepository],
  exports: [PageCommentService, PageCommentRepository],
})
export class PageCommentModule {}

export const CommentModule = PageCommentModule;
export type CommentModule = PageCommentModule;
