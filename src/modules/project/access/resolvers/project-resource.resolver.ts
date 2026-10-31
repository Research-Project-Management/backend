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
      let authoritativePageId: string | undefined;
      const pageId =
        (typeof request.params?.pageId === 'string' && request.params.pageId) ||
        (typeof request.params?.docId === 'string' && request.params.docId) ||
        (typeof request.params?.rootPageId === 'string' &&
          request.params.rootPageId) ||
        (typeof request.body?.pageId === 'string' && request.body.pageId) ||
        (typeof request.body?.page_id === 'string' && request.body.page_id) ||
        (typeof request.body?.docId === 'string' && request.body.docId) ||
        (typeof request.body?.doc_id === 'string' && request.body.doc_id) ||
        (typeof request.query?.pageId === 'string' && request.query.pageId) ||
        (typeof request.query?.page_id === 'string' && request.query.page_id);

      if (pageId && isUUID(pageId)) {
        const doc = await this.prisma.manuscriptDoc.findUnique({
          where: { id: pageId },
          select: { id: true, projectId: true },
        });
        if (doc?.projectId) {
          resolvedResourceProjects.set(`doc:${pageId}`, doc.projectId);
          authoritativePageId = doc.id;
        } else {
          // Check if the pageId is a ManuscriptNode ID
          const node = await this.prisma.manuscriptNode.findUnique({
            where: { id: pageId },
            select: { id: true, projectId: true, docId: true },
          });
          if (node?.projectId) {
            resolvedResourceProjects.set(`node:${pageId}`, node.projectId);
            authoritativePageId = node.docId || node.id;
          } else {
            // Check if the pageId is a ManuscriptFile ID (e.g. when restoring a deleted binary file)
            const file = await this.prisma.manuscriptFile?.findUnique?.({
              where: { id: pageId },
              select: { id: true, projectId: true },
            });
            if (file?.projectId) {
              resolvedResourceProjects.set(`file:${pageId}`, file.projectId);
              authoritativePageId = file.id;
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

      // 7. Resolve from Library Resource IDs (Item, Attachment, Collection, Annotation, Tag, Note)
      const isLibraryContext =
        typeof request.url === 'string' && request.url.includes('/library');
      if (isLibraryContext) {
        const itemId =
          (typeof request.params?.itemId === 'string' &&
            request.params.itemId) ||
          (typeof request.body?.itemId === 'string' && request.body.itemId) ||
          (typeof request.body?.primaryItemId === 'string' &&
            request.body.primaryItemId);
        if (itemId && isUUID(itemId) && (this.prisma as any).item?.findUnique) {
          const item = await this.prisma.item.findUnique({
            where: { id: itemId },
            select: { projectId: true },
          });
          if (item?.projectId) {
            resolvedResourceProjects.set(`item:${itemId}`, item.projectId);
          }
        }

        const attachmentId =
          (typeof request.params?.attachmentId === 'string' &&
            request.params.attachmentId) ||
          (typeof request.body?.attachmentId === 'string' &&
            request.body.attachmentId);
        if (
          attachmentId &&
          isUUID(attachmentId) &&
          (this.prisma as any).attachment?.findUnique
        ) {
          const attachment = await this.prisma.attachment.findUnique({
            where: { id: attachmentId },
            select: { item: { select: { projectId: true } } },
          });
          if (attachment?.item?.projectId) {
            resolvedResourceProjects.set(
              `attachment:${attachmentId}`,
              attachment.item.projectId,
            );
          }
        }

        const collectionId =
          (typeof request.params?.collectionId === 'string' &&
            request.params.collectionId) ||
          (typeof request.body?.collectionId === 'string' &&
            request.body.collectionId);
        if (
          collectionId &&
          isUUID(collectionId) &&
          (this.prisma as any).collection?.findUnique
        ) {
          const collection = await this.prisma.collection.findUnique({
            where: { id: collectionId },
            select: { projectId: true },
          });
          if (collection?.projectId) {
            resolvedResourceProjects.set(
              `collection:${collectionId}`,
              collection.projectId,
            );
          }
        }

        const annotationId =
          typeof request.params?.annotationId === 'string'
            ? request.params.annotationId
            : undefined;
        if (
          annotationId &&
          isUUID(annotationId) &&
          (this.prisma as any).annotation?.findUnique
        ) {
          const annotation = await this.prisma.annotation.findUnique({
            where: { id: annotationId },
            select: {
              attachment: { select: { item: { select: { projectId: true } } } },
            },
          });
          if (annotation?.attachment?.item?.projectId) {
            resolvedResourceProjects.set(
              `annotation:${annotationId}`,
              annotation.attachment.item.projectId,
            );
          }
        }

        const tagId =
          typeof request.params?.tagId === 'string'
            ? request.params.tagId
            : undefined;
        if (tagId && isUUID(tagId) && (this.prisma as any).tag?.findUnique) {
          const tag = await this.prisma.tag.findUnique({
            where: { id: tagId },
            select: { projectId: true },
          });
          if (tag?.projectId) {
            resolvedResourceProjects.set(`tag:${tagId}`, tag.projectId);
          }
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

      const PERSONAL_ALIASES = new Set([
        '',
        'undefined',
        'null',
        'me',
        'user',
        'personal',
        'global',
        'default',
      ]);

      const resolveSingleHint = async (
        raw: unknown,
      ): Promise<{
        provided: boolean;
        isPersonal: boolean;
        projectId?: string;
      }> => {
        if (raw === undefined || raw === null) {
          return { provided: false, isPersonal: false };
        }
        if (typeof raw !== 'string') {
          throw new ForbiddenException({
            statusCode: 403,
            code: 'PROJECT_CONTEXT_MISMATCH',
            message: 'Invalid project context format',
          });
        }
        const trimmed = raw.trim();
        if (PERSONAL_ALIASES.has(trimmed.toLowerCase())) {
          return { provided: true, isPersonal: true };
        }
        if (isUUID(trimmed)) {
          return { provided: true, isPersonal: false, projectId: trimmed };
        }
        const project = await this.prisma.project?.findFirst?.({
          where: {
            identifier: { equals: trimmed, mode: 'insensitive' },
            deletedAt: null,
          },
          select: { id: true },
        });
        if (project?.id) {
          return { provided: true, isPersonal: false, projectId: project.id };
        }
        throw new ForbiddenException({
          statusCode: 403,
          code: 'ACCESS_DENIED',
          message: 'Invalid or unknown project identifier',
        });
      };

      // 7. Resolve and cross-check all client hints (header, query, body)
      const hintSources: Array<[string, unknown]> = [
        ['header:x-project-id', request.headers?.['x-project-id']],
        ['query:projectId', request.query?.projectId],
        ['body:projectId', request.body?.projectId],
        ['body:project_id', request.body?.project_id],
      ];

      const resolvedHints: Array<{ source: string; projectId: string }> = [];
      for (const [source, rawVal] of hintSources) {
        const res = await resolveSingleHint(rawVal);
        if (res.provided && !res.isPersonal && res.projectId) {
          resolvedHints.push({ source, projectId: res.projectId });
        }
      }

      const distinctHintIds = Array.from(
        new Set(resolvedHints.map((h) => h.projectId.toLowerCase())),
      );
      if (distinctHintIds.length > 1) {
        this.logger.warn(
          `Project context mismatch across client hints: ${resolvedHints
            .map((h) => `${h.source}=${h.projectId}`)
            .join(', ')}`,
        );
        throw new ForbiddenException({
          statusCode: 403,
          code: 'PROJECT_CONTEXT_MISMATCH',
          message:
            'Conflicting project context hints between header, query, and body',
        });
      }

      const normalizedClientHint = resolvedHints[0]?.projectId;

      const synchronizeRequestProjectScope = (finalProjectId: string | null) => {
        if (finalProjectId) {
          request.resolvedProjectId = finalProjectId;
          if (authoritativePageId) {
            request.resolvedPageId = authoritativePageId;
          } else if (pageId && isUUID(pageId)) {
            request.resolvedPageId = pageId;
          }
          if (request.query && 'projectId' in request.query) {
            request.query.projectId = finalProjectId;
          }
          if (
            request.body &&
            typeof request.body === 'object' &&
            'projectId' in request.body
          ) {
            request.body.projectId = finalProjectId;
          }
          if (
            request.body &&
            typeof request.body === 'object' &&
            'project_id' in request.body
          ) {
            request.body.project_id = finalProjectId;
          }
          if (request.params && 'projectId' in request.params) {
            request.params.projectId = finalProjectId;
          }
        } else {
          delete request.resolvedProjectId;
          delete request.resolvedPageId;
          if (request.query && 'projectId' in request.query) {
            delete request.query.projectId;
          }
          if (
            request.body &&
            typeof request.body === 'object' &&
            'projectId' in request.body
          ) {
            delete request.body.projectId;
          }
          if (
            request.body &&
            typeof request.body === 'object' &&
            'project_id' in request.body
          ) {
            delete request.body.project_id;
          }
        }
      };

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

      // 9. Resolve from route path parameter :projectId
      const paramRes = await resolveSingleHint(request.params?.projectId);
      const normalizedParamProject =
        paramRes.provided && !paramRes.isPersonal
          ? paramRes.projectId
          : undefined;

      if (authoritativeResourceProjectId && normalizedParamProject) {
        if (
          authoritativeResourceProjectId.toLowerCase() !==
          normalizedParamProject.toLowerCase()
        ) {
          this.logger.warn(
            `Project context mismatch: resource project (${authoritativeResourceProjectId}) disagrees with path param (${normalizedParamProject})`,
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
        synchronizeRequestProjectScope(authoritativeResourceProjectId);
        return {
          projectId: authoritativeResourceProjectId,
          source: 'resource',
        };
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
        synchronizeRequestProjectScope(normalizedParamProject);
        return {
          projectId: normalizedParamProject,
          source: 'param',
        };
      }

      // 10. Fallback to client hint if no resource or path param was present
      if (normalizedClientHint) {
        synchronizeRequestProjectScope(normalizedClientHint);
        return {
          projectId: normalizedClientHint,
          source: 'hint',
        };
      }

      synchronizeRequestProjectScope(null);
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
