import { Module } from '@nestjs/common';
import { WorkspaceModule } from './workspace/workspace.module';
import { ProjectModule } from './project/project.module';

@Module({
  imports: [WorkspaceModule, ProjectModule],
  exports: [WorkspaceModule, ProjectModule],
})
export class OrganizationModule {}
