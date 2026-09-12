import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TaskCommentController } from './comment.controller';
import { TaskCommentService } from './comment.service';
import { TaskCommentRepository } from './comment.repository';

@Module({
  imports: [EventEmitterModule],
  controllers: [TaskCommentController],
  providers: [TaskCommentService, TaskCommentRepository],
  exports: [TaskCommentService],
})
export class CommentModule {}
