import { Module } from '@nestjs/common';
import { CommentController } from './comment.controller';
import { CommentService } from './comment.service';
import { CommentRepository } from './comment.repository';
import { CollaborationModule } from '../collaboration/collaboration.module';
import { NotificationBundlerModule } from '../notification/notification-bundler.module';

@Module({
  imports: [CollaborationModule, NotificationBundlerModule],
  controllers: [CommentController],
  providers: [CommentService, CommentRepository],
  exports: [CommentService],
})
export class CommentModule {}

export const PageCommentModule = CommentModule;
export type PageCommentModule = CommentModule;
