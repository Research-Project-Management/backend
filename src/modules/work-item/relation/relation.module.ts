import { Module } from '@nestjs/common';
import { RelationController } from './relation.controller';
import { RelationService } from './relation.service';
import { RelationRepository } from './relation.repository';

@Module({
  imports: [],
  controllers: [RelationController],
  providers: [RelationService, RelationRepository],
  exports: [RelationService, RelationRepository],
})
export class RelationModule {}
