import { Module } from '@nestjs/common';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';
import { WorkspaceRepository } from './workspace.repository';
import { WorkspaceInvitationRepository } from './workspace-invitation.repository';

@Module({
  controllers: [WorkspaceController],
  providers: [
    WorkspaceService,
    WorkspaceRepository,
    WorkspaceInvitationRepository,
  ],
  exports: [
    WorkspaceService,
    WorkspaceRepository,
    WorkspaceInvitationRepository,
  ],
})
export class WorkspaceModule {}
