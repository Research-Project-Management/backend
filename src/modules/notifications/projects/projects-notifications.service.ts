/**
 * modules/notifications/projects/projects-notifications.service.ts
 * Specialized Notification Service for Projects domain (Invitations, Member events).
 */

import { Injectable } from '@nestjs/common';
import { CreateNotificationUseCase } from '../core/use-cases/create-notification.use-case';
import { DeleteNotificationUseCase } from '../core/use-cases/delete-notification.use-case';
import { NotificationEntity } from '../core/domain/entities/notification.entity';

export interface ProjectInvitationNotificationDto {
  recipientUserId: string;
  projectId: string;
  projectName?: string;
  inviterId: string;
  inviterName?: string;
  inviterEmail?: string;
  role: string;
  token: string;
  expiresAt: Date;
}

@Injectable()
export class ProjectsNotificationsService {
  constructor(
    private readonly createNotificationUseCase: CreateNotificationUseCase,
    private readonly deleteNotificationUseCase: DeleteNotificationUseCase,
  ) {}

  /**
   * Dispatches project invitation notification to the invited user.
   */
  async notifyProjectInvitation(
    dto: ProjectInvitationNotificationDto,
  ): Promise<NotificationEntity> {
    return this.createNotificationUseCase.execute({
      userId: dto.recipientUserId,
      key: `project_invite_${dto.projectId}_${dto.recipientUserId}`,
      templateKey: 'project_invite',
      type: 'project_invite',
      projectId: dto.projectId,
      actorId: dto.inviterId,
      messageOpts: {
        projectId: dto.projectId,
        projectName: dto.projectName || 'Manuscript',
        inviterName: dto.inviterName || dto.inviterEmail || 'A collaborator',
        inviterEmail: dto.inviterEmail,
        role: dto.role,
        token: dto.token,
      },
      expiresAt: dto.expiresAt,
    });
  }

  /**
   * Dismisses pending invitation notification when accepted or declined.
   */
  async dismissProjectInvitation(
    projectId: string,
    userId: string,
  ): Promise<number> {
    return this.deleteNotificationUseCase.deleteByKey(
      `project_invite_${projectId}_${userId}`,
    );
  }
}
