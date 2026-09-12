import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CommentController, TaskCommentController } from './comment.controller';
import { CommentService, TaskCommentService } from './comment.service';
import { CommentRepository, TaskCommentRepository } from './comment.repository';

@Module({
  imports: [EventEmitterModule],
  controllers: [CommentController],
  providers: [CommentService, CommentRepository],
  exports: [CommentService],
})
export class CommentModule {}

export const TaskCommentModule = CommentModule;
export type TaskCommentModule = CommentModule;
