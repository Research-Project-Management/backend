import { Module } from '@nestjs/common';
import { LabelModule } from './label/label.module';
import { CommentModule } from './comment/comment.module';

@Module({
  imports: [LabelModule, CommentModule],
  exports: [LabelModule, CommentModule],
})
export class SharedModule {}
