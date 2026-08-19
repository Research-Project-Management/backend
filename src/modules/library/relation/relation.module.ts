import { Module } from '@nestjs/common';
import { RelationController } from './relation.controller';
import { RelationService } from './relation.service';
import { PaperModule } from '../paper/paper.module';

@Module({
  imports: [PaperModule],
  controllers: [RelationController],
  providers: [RelationService],
  exports: [RelationService],
})
export class RelationModule {}
