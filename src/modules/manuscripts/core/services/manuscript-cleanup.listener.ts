/**
 * modules/manuscripts/core/services/manuscript-cleanup.listener.ts
 *
 * Cascading deletion listener for deleted projects to prevent orphaned manuscript rows.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '@/core';
import { ProjectWorkspaceCollectorService } from './project-workspace-collector.service';

interface ProjectDeletedEvent {
  projectId?: string;
  entityId?: string;
}

@Injectable()
export class ManuscriptCleanupListener {
  private readonly logger = new Logger(ManuscriptCleanupListener.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly workspaceCollector?: ProjectWorkspaceCollectorService,
  ) {}

  @OnEvent('project.deleted', { async: true })
  public async handleProjectDeleted(event: ProjectDeletedEvent): Promise<void> {
    const projectId = event?.projectId || event?.entityId;
    if (!projectId) return;

    try {
      this.logger.log(
        `Starting cascading cleanup for deleted project ${projectId} across manuscript stores...`,
      );

      if (this.workspaceCollector && this.prisma.manuscriptDoc?.findMany) {
        try {
          const docs = await this.prisma.manuscriptDoc.findMany({
            where: { projectId },
            select: { id: true },
          });
          if (Array.isArray(docs) && docs.length > 0) {
            await Promise.all(
              docs.map((d) =>
                this.workspaceCollector!
                  .evictDoc(projectId, d.id)
                  .catch(() => undefined),
              ),
            );
          }
        } catch {
          // Non-blocking Yjs eviction before DB cleanup
        }
      }

      const operations = [
        this.prisma.manuscriptTrackChange.deleteMany({ where: { projectId } }),
        this.prisma.manuscriptCommentThread.deleteMany({ where: { projectId } }),
        ...(this.prisma.manuscriptDocReview
          ? [this.prisma.manuscriptDocReview.deleteMany({ where: { projectId } })]
          : []),
        ...(this.prisma.manuscriptLinkedFile
          ? [this.prisma.manuscriptLinkedFile.deleteMany({ where: { projectId } })]
          : []),
        this.prisma.manuscriptNode.deleteMany({ where: { projectId } }),
        this.prisma.manuscriptFile.deleteMany({ where: { projectId } }),
        this.prisma.manuscriptSnapshot.deleteMany({ where: { projectId } }),
        this.prisma.manuscriptNotification.deleteMany({ where: { projectId } }),
        this.prisma.manuscriptCustomWord.deleteMany({ where: { projectId } }),
        this.prisma.manuscriptDoc.deleteMany({ where: { projectId } }),
      ];
      await this.prisma.$transaction(operations);

      this.logger.log(
        `Successfully cascaded cleanup for deleted project ${projectId}`,
      );
    } catch (err: unknown) {
      this.logger.error(
        `Error during manuscript cascading cleanup for project ${projectId}: ${err}`,
      );
    }
  }
}
