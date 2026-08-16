import { Module } from '@nestjs/common';
import { StickyModule } from './sticky/sticky.module';
import { LabelModule } from './label/label.module';
import { CommentModule } from './comment/comment.module';

@Module({
  imports: [StickyModule, LabelModule, CommentModule],
  exports: [StickyModule, LabelModule, CommentModule],
})
export class SharedModule {}
