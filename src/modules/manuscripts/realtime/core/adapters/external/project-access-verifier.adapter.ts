/**
 * realtime/core/adapters/external/project-access-verifier.adapter.ts
 * Driven Adapter implementing IProjectAccessVerifierPort to verify workspace membership & editing roles.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IProjectAccessVerifierPort,
  ProjectAccessResult,
} from '../../ports/project-access-verifier.port';
import { PrismaService } from '@/core/database/prisma.service';

@Injectable()
export class ProjectAccessVerifierAdapter extends IProjectAccessVerifierPort {
  private readonly logger = new Logger(ProjectAccessVerifierAdapter.name);

  constructor(@Optional() private readonly prisma?: PrismaService) {
    super();
  }

  public async verifyProjectAccess(
    userId: string,
    projectId: string,
  ): Promise<ProjectAccessResult> {
    if (!this.prisma) {
      // In test double mode or without DB connection
      return { canRead: true, canWrite: true, role: 'contributor' };
    }

    try {
      // 1. Check if user is project owner
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { createdById: true },
      });

      if (!project) {
        return { canRead: false, canWrite: false, role: 'none' };
      }

      if (project.createdById === userId) {
        return { canRead: true, canWrite: true, role: 'owner' };
      }

      // 2. Check membership
      const member = await this.prisma.projectMember.findUnique({
        where: {
          projectId_userId: {
            projectId,
            userId,
          },
        },
        select: { role: true },
      });

      if (!member) {
        return { canRead: false, canWrite: false, role: 'none' };
      }

      const isReviewer = member.role === 'reviewer';
      return {
        canRead: true,
        canWrite: !isReviewer,
        role: member.role,
      };
    } catch (err) {
      this.logger.warn(`Error verifying access for user ${userId} to project ${projectId}: ${err}`);
      return { canRead: false, canWrite: false, role: 'none' };
    }
  }
}
