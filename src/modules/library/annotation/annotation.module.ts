import { Module } from '@nestjs/common';
import { AnnotationController } from './annotation.controller';
import { AnnotationService } from './annotation.service';
import { PaperModule } from '../paper/paper.module';

@Module({
  imports: [PaperModule],
  controllers: [AnnotationController],
  providers: [AnnotationService],
  exports: [AnnotationService],
})
export class AnnotationModule {}
