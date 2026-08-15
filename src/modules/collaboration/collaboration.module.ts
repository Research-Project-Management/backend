import { Module } from '@nestjs/common';
import { CommentModule } from './comment/comment.module';
import { StickyModule } from './sticky/sticky.module';

@Module({
  imports: [CommentModule, StickyModule],
  exports: [CommentModule, StickyModule],
})
export class CollaborationModule {}
