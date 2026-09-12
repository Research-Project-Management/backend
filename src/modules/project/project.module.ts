import { Module } from '@nestjs/common';
import { ProjectController } from './project.controller';
import { ProjectService } from './project.service';
import { ProjectRepository } from './project.repository';
import { MemberModule } from './member/member.module';

@Module({
  imports: [MemberModule],
  controllers: [ProjectController],
  providers: [ProjectService, ProjectRepository],
  exports: [ProjectService, MemberModule],
})
export class ProjectModule {}
