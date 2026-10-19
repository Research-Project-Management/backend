import { Injectable, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import { isUUID } from 'class-validator';

export interface ResolvedProjectResult {
  projectId: string;
  source: 'resource' | 'param' | 'hint';
}

@Injectable()
export class ProjectResourceResolver {
  private readonly logger = new Logger(ProjectResourceResolver.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Authoritatively derives the project ID from referenced resources and verifies
   * consistency with any client-supplied hints or path parameters.
   * Fails closed on database exceptions or context mismatches.
   */
  async resolveAuthoritativeProjectId(
    request: any,
  ): Promise<ResolvedProjectResult | null> {
    try {
      const resolvedResourceProjects = new Map<string, string>(); // resourceType -> projectId

      // 1. Resolve from Document / Page IDs
      const pageId =
        (typeof request.params?.pageId === 'string' && request.params.pageId) ||
        (typeof request.params?.docId === 'string' && request.params.docId) ||
        (typeof request.body?.pageId === 'string' && request.body.pageId) ||
        (typeof request.body?.page_id === 'string' && request.body.page_id) ||
        (typeof request.body?.docId === 'string' && request.body.docId) ||
        (typeof request.body?.doc_id === 'string' && request.body.doc_id) ||
        (typeof request.query?.pageId === 'string' && request.query.pageId) ||
        (typeof request.query?.page_id === 'string' && request.query.page_id);

      if (pageId && isUUID(pageId)) {
        const doc = await this.prisma.manuscriptDoc.findUnique({
          where: { id: pageId },
          select: { projectId: true },
        });
        if (doc?.projectId) {
          resolvedResourceProjects.set(`doc:${pageId}`, doc.projectId);
        } else {
          // Check if the pageId is a ManuscriptNode ID
          const node = await this.prisma.manuscriptNode.findUnique({
            where: { id: pageId },
            select: { projectId: true },
          });
          if (node?.projectId) {
            resolvedResourceProjects.set(`node:${pageId}`, node.projectId);
          } else {
            // Legacy support: check if the pageId is actually a project ID
            const project = await this.prisma.project.findUnique({
              where: { id: pageId },
              select: { id: true },
            });
            if (project?.id) {
              resolvedResourceProjects.set(`project:${pageId}`, project.id);
            }
          }
        }
      }

      // Check secondary docId in body if different from pageId
      const candidateBodyDocId =
        (typeof request.body?.docId === 'string' && request.body.docId) ||
        (typeof request.body?.doc_id === 'string' && request.body.doc_id) ||
        undefined;
      const bodyDocId =
        candidateBodyDocId && candidateBodyDocId !== pageId
          ? candidateBodyDocId
          : undefined;
      if (bodyDocId && isUUID(bodyDocId)) {
        const doc = await this.prisma.manuscriptDoc.findUnique({
          where: { id: bodyDocId },
          select: { projectId: true },
        });
        if (doc?.projectId) {
          resolvedResourceProjects.set(`doc:${bodyDocId}`, doc.projectId);
        } else {
          const node = await this.prisma.manuscriptNode.findUnique({
            where: { id: bodyDocId },
            select: { projectId: true },
          });
          if (node?.projectId) {
            resolvedResourceProjects.set(`node:${bodyDocId}`, node.projectId);
          }
        }
      }

      // 2. Resolve from Manuscript Node ID
      const nodeId =
        (typeof request.params?.nodeId === 'string' && request.params.nodeId) ||
        (typeof request.body?.nodeId === 'string' && request.body.nodeId);
      if (nodeId && isUUID(nodeId)) {
        const node = await this.prisma.manuscriptNode.findUnique({
          where: { id: nodeId },
          select: { projectId: true },
        });
        if (node?.projectId) {
          resolvedResourceProjects.set(`node:${nodeId}`, node.projectId);
        }
      }

      // 3. Resolve from Manuscript File ID / Asset ID
      const fileId =
        (typeof request.params?.fileId === 'string' && request.params.fileId) ||
        (typeof request.body?.fileId === 'string' && request.body.fileId);
      if (fileId && isUUID(fileId)) {
        const file = await this.prisma.manuscriptFile.findUnique({
          where: { id: fileId },
          select: { projectId: true },
        });
        if (file?.projectId) {
          resolvedResourceProjects.set(`file:${fileId}`, file.projectId);
        }
      }

      const assetId =
        typeof request.params?.assetId === 'string'
          ? request.params.assetId
          : undefined;
      if (assetId && isUUID(assetId)) {
        const file = await this.prisma.file.findUnique({
          where: { id: assetId },
          select: { linkedToId: true },
        });
        if (file?.linkedToId) {
          resolvedResourceProjects.set(`asset:${assetId}`, file.linkedToId);
        }
      }

      // 4. Resolve from Comment / Thread ID
      const commentId =
        (typeof request.params?.commentId === 'string' &&
          request.params.commentId) ||
        (typeof request.params?.threadId === 'string' &&
          request.params.threadId) ||
        (typeof request.body?.commentId === 'string' &&
          request.body.commentId) ||
        (typeof request.body?.threadId === 'string' && request.body.threadId);
      if (commentId && isUUID(commentId)) {
        const thread = await this.prisma.manuscriptCommentThread.findUnique({
          where: { id: commentId },
          select: { projectId: true },
        });
        if (thread?.projectId) {
          resolvedResourceProjects.set(`thread:${commentId}`, thread.projectId);
        } else {
          // WorkItem comment check
          const comment = await this.prisma.workItemComment.findUnique({
            where: { id: commentId },
            select: { workItem: { select: { projectId: true } } },
          });
          if (comment?.workItem?.projectId) {
            resolvedResourceProjects.set(
              `workItemComment:${commentId}`,
              comment.workItem.projectId,
            );
          }
        }
      }

      // 5. Resolve from Snapshot / Version ID
      const versionId =
        (typeof request.params?.versionId === 'string' &&
          request.params.versionId) ||
        (typeof request.params?.snapshotId === 'string' &&
          request.params.snapshotId) ||
        (typeof request.body?.versionId === 'string' &&
          request.body.versionId) ||
        (typeof request.body?.snapshotId === 'string' &&
          request.body.snapshotId);
      if (versionId && isUUID(versionId)) {
        const snapshot = await this.prisma.manuscriptSnapshot.findUnique({
          where: { id: versionId },
          select: { projectId: true },
        });
        if (snapshot?.projectId) {
          resolvedResourceProjects.set(
            `snapshot:${versionId}`,
            snapshot.projectId,
          );
        }
      }

      // 6. Resolve from Work Item ID
      const workItemId =
        (typeof request.params?.workItemId === 'string' &&
          request.params.workItemId) ||
        (typeof request.body?.workItemId === 'string' &&
          request.body.workItemId) ||
        (Array.isArray(request.body?.workItemIds) &&
          typeof request.body.workItemIds[0] === 'string' &&
          request.body.workItemIds[0]) ||
        (Array.isArray(request.body?.ids) &&
          typeof request.body.ids[0] === 'string' &&
          request.body.ids[0]);
      if (workItemId) {
        const where = isUUID(workItemId)
          ? { id: workItemId }
          : {
              identifier: { equals: workItemId, mode: 'insensitive' as const },
            };
        const workItem = await this.prisma.workItem.findFirst({
          where,
          select: { projectId: true },
        });
        if (workItem?.projectId) {
          resolvedResourceProjects.set(
            `workItem:${workItemId}`,
            workItem.projectId,
          );
        }
      }

      // Verify mutual agreement among all referenced resources
      const uniqueResourceProjectIds = Array.from(
        new Set(
          Array.from(resolvedResourceProjects.values()).map((id) =>
            id.toLowerCase(),
          ),
        ),
      );

      if (uniqueResourceProjectIds.length > 1) {
        this.logger.warn(
          `Project context mismatch: resources belong to multiple distinct projects (${Array.from(
            resolvedResourceProjects.entries(),
          )
            .map(([k, v]) => `${k}->${v}`)
            .join(', ')})`,
        );
        throw new ForbiddenException({
          statusCode: 403,
          code: 'PROJECT_CONTEXT_MISMATCH',
          message: 'Resource does not belong to the requested project context',
        });
      }

      const authoritativeResourceProjectId =
        uniqueResourceProjectIds.length === 1
          ? Array.from(resolvedResourceProjects.values())[0]
          : undefined;

      // 7. Resolve and normalize client hints (header, query, body)
      const rawClientHint =
        request.headers?.['x-project-id'] ||
        request.query?.projectId ||
        (typeof request.body?.projectId === 'string'
          ? request.body.projectId
          : undefined) ||
        (typeof request.body?.project_id === 'string'
          ? request.body.project_id
          : undefined);

      let normalizedClientHint: string | undefined;
      if (rawClientHint && typeof rawClientHint === 'string') {
        const trimmed = rawClientHint.trim();
        if (isUUID(trimmed)) {
          normalizedClientHint = trimmed;
        } else if (
          ![
            'undefined',
            'null',
            'me',
            'user',
            'personal',
            'global',
            'default',
          ].includes(trimmed.toLowerCase())
        ) {
          const project = await this.prisma.project.findFirst({
            where: {
              identifier: { equals: trimmed, mode: 'insensitive' },
              deletedAt: null,
            },
            select: { id: true },
          });
          if (project?.id) {
            normalizedClientHint = project.id;
          }
        }
      }

      // 8. Cross-check client hint with authoritative resource project
      if (authoritativeResourceProjectId && normalizedClientHint) {
        if (
          authoritativeResourceProjectId.toLowerCase() !==
          normalizedClientHint.toLowerCase()
        ) {
          this.logger.warn(
            `Project context mismatch: resource project (${authoritativeResourceProjectId}) disagrees with client hint (${normalizedClientHint})`,
          );
          throw new ForbiddenException({
            statusCode: 403,
            code: 'PROJECT_CONTEXT_MISMATCH',
            message:
              'Resource does not belong to the requested project context',
          });
        }
      }

      if (authoritativeResourceProjectId) {
        return {
          projectId: authoritativeResourceProjectId,
          source: 'resource',
        };
      }

      // 9. If no resource, resolve from route path parameter :projectId
      const rawParamProject = request.params?.projectId;
      let normalizedParamProject: string | undefined;
      if (rawParamProject && typeof rawParamProject === 'string') {
        const trimmed = rawParamProject.trim();
        if (isUUID(trimmed)) {
          normalizedParamProject = trimmed;
        } else if (
          ![
            'undefined',
            'null',
            'me',
            'user',
            'personal',
            'global',
            'default',
          ].includes(trimmed.toLowerCase())
        ) {
          const project = await this.prisma.project.findFirst({
            where: {
              identifier: { equals: trimmed, mode: 'insensitive' },
              deletedAt: null,
            },
            select: { id: true },
          });
          if (project?.id) {
            normalizedParamProject = project.id;
          }
        }
      }

      if (normalizedParamProject) {
        if (
          normalizedClientHint &&
          normalizedParamProject.toLowerCase() !==
            normalizedClientHint.toLowerCase()
        ) {
          this.logger.warn(
            `Project context mismatch: path param project (${normalizedParamProject}) disagrees with client hint (${normalizedClientHint})`,
          );
          throw new ForbiddenException({
            statusCode: 403,
            code: 'PROJECT_CONTEXT_MISMATCH',
            message:
              'Resource does not belong to the requested project context',
          });
        }
        return {
          projectId: normalizedParamProject,
          source: 'param',
        };
      }

      // 10. Fallback to client hint if no resource or path param was present
      if (normalizedClientHint) {
        return {
          projectId: normalizedClientHint,
          source: 'hint',
        };
      }

      return null;
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }
      this.logger.error(
        `Project resolution failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new ForbiddenException({
        statusCode: 403,
        code: 'ACCESS_DENIED',
        message: 'Access denied',
      });
    }
  }
}
