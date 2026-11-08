import { Module } from '@nestjs/common';
import { AssignmentController } from './assignment.controller';
import { AssignmentService } from './assignment.service';
import { AssignmentRepository } from './assignment.repository';

@Module({
  imports: [],
  controllers: [AssignmentController],
  providers: [AssignmentService, AssignmentRepository],
  exports: [AssignmentService, AssignmentRepository],
})
export class AssignmentModule {}
