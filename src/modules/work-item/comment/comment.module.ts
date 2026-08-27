import { Module } from '@nestjs/common';
import { TaskCommentController } from './comment.controller';
import { TaskCommentService } from './comment.service';
import { TaskCommentRepository } from './comment.repository';

@Module({
  controllers: [TaskCommentController],
  providers: [TaskCommentService, TaskCommentRepository],
  exports: [TaskCommentService, TaskCommentRepository],
})
export class TaskCommentModule {}

export const CommentModule = TaskCommentModule;
export type CommentModule = TaskCommentModule;
