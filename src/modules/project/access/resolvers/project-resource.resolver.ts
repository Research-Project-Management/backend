import { Injectable, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import { isUUID } from 'class-validator';

export interface ResolvedProjectResult {
  projectId: string;
  spaceId: string;
  isPersonalSpace: boolean;
  source: 'resource' | 'param' | 'hint';
}

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

@Injectable()
export class ProjectResourceResolver {
  private readonly logger = new Logger(ProjectResourceResolver.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Authoritatively derives the Space ID (`spaceId` = `projectId` for project space,
   * or `userId` for personal space) from referenced resources and verifies
   * consistency with any client-supplied hints or path parameters.
   * Fails closed on database exceptions or context mismatches.
   */
  async resolveAuthoritativeProjectId(
    request: any,
  ): Promise<ResolvedProjectResult | null> {
    try {
      const currentUserId: string | undefined =
        request.user?.sub || request.user?.id;
      const resolvedResourceSpaces = new Map<string, string>(); // resourceType -> spaceId

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
        const doc = await this.prisma.pageDoc.findUnique({
          where: { id: pageId },
          select: { id: true, spaceId: true },
        });
        if (doc?.spaceId) {
          resolvedResourceSpaces.set(`doc:${pageId}`, doc.spaceId);
          authoritativePageId = doc.id;
        } else {
          // Check if the pageId is a Page Aggregate Root ID
          const page = await this.prisma.page?.findUnique?.({
            where: { id: pageId },
            select: { id: true, spaceId: true },
          });
          if (page?.spaceId) {
            resolvedResourceSpaces.set(`page:${pageId}`, page.spaceId);
            authoritativePageId = page.id;
          } else {
            // Check if the pageId is a PageNode ID
            const node = await this.prisma.pageNode.findUnique({
              where: { id: pageId },
              select: { id: true, spaceId: true, docId: true },
            });
            if (node?.spaceId) {
              resolvedResourceSpaces.set(`node:${pageId}`, node.spaceId);
              authoritativePageId = node.docId || node.id;
            } else {
              // Check if the pageId is a PageFile ID
              const file = await this.prisma.pageFile?.findUnique?.({
                where: { id: pageId },
                select: { id: true, spaceId: true },
              });
              if (file?.spaceId) {
                resolvedResourceSpaces.set(`file:${pageId}`, file.spaceId);
                authoritativePageId = file.id;
              } else {
                // Legacy support: check if the pageId is actually a project ID or user ID (personal space)
                if (
                  currentUserId &&
                  pageId.toLowerCase() === currentUserId.toLowerCase()
                ) {
                  resolvedResourceSpaces.set(`space:${pageId}`, currentUserId);
                } else {
                  const project = await this.prisma.project.findUnique({
                    where: { id: pageId },
                    select: { id: true },
                  });
                  if (project?.id) {
                    resolvedResourceSpaces.set(`project:${pageId}`, project.id);
                  }
                }
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
        const doc = await this.prisma.pageDoc.findUnique({
          where: { id: bodyDocId },
          select: { spaceId: true },
        });
        if (doc?.spaceId) {
          resolvedResourceSpaces.set(`doc:${bodyDocId}`, doc.spaceId);
        } else {
          const node = await this.prisma.pageNode.findUnique({
            where: { id: bodyDocId },
            select: { spaceId: true },
          });
          if (node?.spaceId) {
            resolvedResourceSpaces.set(`node:${bodyDocId}`, node.spaceId);
          }
        }
      }

      // 2. Resolve from Page Node ID
      const nodeId =
        (typeof request.params?.nodeId === 'string' && request.params.nodeId) ||
        (typeof request.body?.nodeId === 'string' && request.body.nodeId);
      if (nodeId && isUUID(nodeId)) {
        const node = await this.prisma.pageNode.findUnique({
          where: { id: nodeId },
          select: { spaceId: true },
        });
        if (node?.spaceId) {
          resolvedResourceSpaces.set(`node:${nodeId}`, node.spaceId);
        }
      }

      // 3. Resolve from Page File ID / Asset ID
      const fileId =
        (typeof request.params?.fileId === 'string' && request.params.fileId) ||
        (typeof request.body?.fileId === 'string' && request.body.fileId);
      if (fileId && isUUID(fileId)) {
        const file = await this.prisma.pageFile.findUnique({
          where: { id: fileId },
          select: { spaceId: true },
        });
        if (file?.spaceId) {
          resolvedResourceSpaces.set(`file:${fileId}`, file.spaceId);
        }
      }

      const assetId =
        typeof request.params?.assetId === 'string'
          ? request.params.assetId
          : undefined;
      if (assetId && isUUID(assetId)) {
        const file = await this.prisma.storageFile.findUnique({
          where: { id: assetId },
          select: { spaceId: true, linkedToId: true },
        });
        if (file?.spaceId) {
          resolvedResourceSpaces.set(`asset:${assetId}`, file.spaceId);
        } else if (file?.linkedToId) {
          resolvedResourceSpaces.set(`asset:${assetId}`, file.linkedToId);
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
        const thread = await this.prisma.pageCommentThread.findUnique({
          where: { id: commentId },
          select: { spaceId: true },
        });
        if (thread?.spaceId) {
          resolvedResourceSpaces.set(`thread:${commentId}`, thread.spaceId);
        } else {
          // WorkItem comment check
          const comment = await this.prisma.workItemComment.findUnique({
            where: { id: commentId },
            select: { workItem: { select: { projectId: true } } },
          });
          if (comment?.workItem?.projectId) {
            resolvedResourceSpaces.set(
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
        const snapshot = await this.prisma.pageSnapshot.findUnique({
          where: { id: versionId },
          select: { spaceId: true },
        });
        if (snapshot?.spaceId) {
          resolvedResourceSpaces.set(`snapshot:${versionId}`, snapshot.spaceId);
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
          resolvedResourceSpaces.set(
            `workItem:${workItemId}`,
            workItem.projectId,
          );
        }
      }

      // 7. Resolve from Library Resource IDs (LibraryItem, Attachment, LibraryCollection, Annotation, LibraryTag, LibraryNote)
      const isLibraryContext =
        typeof request.url === 'string' && request.url.includes('/library');
      if (isLibraryContext) {
        const urlLower =
          typeof request.url === 'string' ? request.url.toLowerCase() : '';
        const itemId =
          (typeof request.params?.itemId === 'string' &&
            request.params.itemId) ||
          (typeof request.body?.itemId === 'string' && request.body.itemId) ||
          (typeof request.body?.primaryItemId === 'string' &&
            request.body.primaryItemId) ||
          (urlLower.includes('/items/') &&
            typeof request.params?.id === 'string' &&
            request.params.id);
        if (
          itemId &&
          isUUID(itemId) &&
          (this.prisma as any).libraryItem?.findUnique
        ) {
          const item = await this.prisma.libraryItem.findUnique({
            where: { id: itemId },
            select: { spaceId: true },
          });
          if (item?.spaceId) {
            resolvedResourceSpaces.set(`item:${itemId}`, item.spaceId);
          }
        }

        const attachmentId =
          (typeof request.params?.attachmentId === 'string' &&
            request.params.attachmentId) ||
          (typeof request.body?.attachmentId === 'string' &&
            request.body.attachmentId) ||
          (urlLower.includes('/attachments/') &&
            typeof request.params?.id === 'string' &&
            request.params.id);
        if (
          attachmentId &&
          isUUID(attachmentId) &&
          (this.prisma as any).attachment?.findUnique
        ) {
          const attachment = await this.prisma.attachment.findUnique({
            where: { id: attachmentId },
            select: { item: { select: { spaceId: true } } },
          });
          if (attachment?.item?.spaceId) {
            resolvedResourceSpaces.set(
              `attachment:${attachmentId}`,
              attachment.item.spaceId,
            );
          }
        }

        const collectionId =
          (typeof request.params?.collectionId === 'string' &&
            request.params.collectionId) ||
          (typeof request.body?.collectionId === 'string' &&
            request.body.collectionId) ||
          (urlLower.includes('/collections/') &&
            typeof request.params?.id === 'string' &&
            request.params.id);
        if (
          collectionId &&
          isUUID(collectionId) &&
          (this.prisma as any).libraryCollection?.findUnique
        ) {
          const collection = await this.prisma.libraryCollection.findUnique({
            where: { id: collectionId },
            select: { spaceId: true },
          });
          if (collection?.spaceId) {
            resolvedResourceSpaces.set(
              `collection:${collectionId}`,
              collection.spaceId,
            );
          }
        }

        const annotationId =
          (typeof request.params?.annotationId === 'string' &&
            request.params.annotationId) ||
          (urlLower.includes('/annotations/') &&
            typeof request.params?.id === 'string' &&
            request.params.id);
        if (
          annotationId &&
          isUUID(annotationId) &&
          (this.prisma as any).annotation?.findUnique
        ) {
          const annotation = await this.prisma.annotation.findUnique({
            where: { id: annotationId },
            select: {
              attachment: { select: { item: { select: { spaceId: true } } } },
            },
          });
          if (annotation?.attachment?.item?.spaceId) {
            resolvedResourceSpaces.set(
              `annotation:${annotationId}`,
              annotation.attachment.item.spaceId,
            );
          }
        }

        const noteId =
          (typeof request.params?.noteId === 'string' &&
            request.params.noteId) ||
          (urlLower.includes('/notes/') &&
            typeof request.params?.id === 'string' &&
            request.params.id);
        if (
          noteId &&
          isUUID(noteId) &&
          (this.prisma as any).libraryNote?.findUnique
        ) {
          const note = await this.prisma.libraryNote.findUnique({
            where: { id: noteId },
            select: { spaceId: true, item: { select: { spaceId: true } } },
          });
          const noteSpaceId = note?.spaceId || note?.item?.spaceId;
          if (noteSpaceId) {
            resolvedResourceSpaces.set(`note:${noteId}`, noteSpaceId);
          }
        }

        const savedSearchId =
          (typeof request.params?.savedSearchId === 'string' &&
            request.params.savedSearchId) ||
          ((urlLower.includes('/saved-searches/') ||
            urlLower.includes('/saved_searches/')) &&
            typeof request.params?.id === 'string' &&
            request.params.id);
        if (
          savedSearchId &&
          isUUID(savedSearchId) &&
          (this.prisma as any).librarySavedSearch?.findUnique
        ) {
          const savedSearch = await this.prisma.librarySavedSearch.findUnique({
            where: { id: savedSearchId },
            select: { spaceId: true },
          });
          if (savedSearch?.spaceId) {
            resolvedResourceSpaces.set(
              `savedSearch:${savedSearchId}`,
              savedSearch.spaceId,
            );
          }
        }

        const subscriptionId =
          (typeof request.params?.subscriptionId === 'string' &&
            request.params.subscriptionId) ||
          ((urlLower.includes('/feeds/') ||
            urlLower.includes('/subscriptions/')) &&
            typeof request.params?.id === 'string' &&
            request.params.id);
        if (
          subscriptionId &&
          isUUID(subscriptionId) &&
          (this.prisma as any).feedSubscription?.findUnique
        ) {
          const sub = await this.prisma.feedSubscription.findUnique({
            where: { id: subscriptionId },
            select: { spaceId: true },
          });
          if (sub?.spaceId) {
            resolvedResourceSpaces.set(
              `feedSubscription:${subscriptionId}`,
              sub.spaceId,
            );
          }
        }

        const runId =
          (typeof request.params?.runId === 'string' && request.params.runId) ||
          (urlLower.includes('/ingestion/') &&
            typeof request.params?.id === 'string' &&
            request.params.id);
        if (
          runId &&
          isUUID(runId) &&
          (this.prisma as any).ingestionRun?.findUnique
        ) {
          const run = await this.prisma.ingestionRun.findUnique({
            where: { id: runId },
            select: { spaceId: true },
          });
          if (run?.spaceId) {
            resolvedResourceSpaces.set(`ingestionRun:${runId}`, run.spaceId);
          }
        }

        const tagId =
          typeof request.params?.tagId === 'string'
            ? request.params.tagId
            : undefined;
        if (
          tagId &&
          isUUID(tagId) &&
          (this.prisma as any).libraryTag?.findUnique
        ) {
          const tag = await this.prisma.libraryTag.findUnique({
            where: { id: tagId },
            select: { spaceId: true },
          });
          if (tag?.spaceId) {
            resolvedResourceSpaces.set(`tag:${tagId}`, tag.spaceId);
          }
        }
      }

      // Verify mutual agreement among all referenced resources
      const uniqueResourceSpaceIds = Array.from(
        new Set(
          Array.from(resolvedResourceSpaces.values()).map((id) =>
            id.toLowerCase(),
          ),
        ),
      );

      if (uniqueResourceSpaceIds.length > 1) {
        this.logger.warn(
          `Space context mismatch: resources belong to multiple distinct spaces (${Array.from(
            resolvedResourceSpaces.entries(),
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

      const authoritativeResourceSpaceId =
        uniqueResourceSpaceIds.length === 1
          ? Array.from(resolvedResourceSpaces.values())[0]
          : undefined;

      const isUserPersonalSpaceId = (candidateId?: string): boolean => {
        if (!candidateId || !currentUserId) return false;
        return candidateId.toLowerCase() === currentUserId.toLowerCase();
      };

      const resolveSingleHint = async (
        raw: unknown,
      ): Promise<{
        provided: boolean;
        isPersonal: boolean;
        spaceId?: string;
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
          return {
            provided: true,
            isPersonal: true,
            spaceId: currentUserId,
          };
        }
        if (isUUID(trimmed)) {
          if (isUserPersonalSpaceId(trimmed)) {
            return {
              provided: true,
              isPersonal: true,
              spaceId: currentUserId,
            };
          }
          return { provided: true, isPersonal: false, spaceId: trimmed };
        }
        const project = await this.prisma.project?.findFirst?.({
          where: {
            identifier: { equals: trimmed, mode: 'insensitive' },
            deletedAt: null,
          },
          select: { id: true },
        });
        if (project?.id) {
          return { provided: true, isPersonal: false, spaceId: project.id };
        }
        throw new ForbiddenException({
          statusCode: 403,
          code: 'ACCESS_DENIED',
          message: 'Invalid or unknown project identifier',
        });
      };

      // 8. Resolve and cross-check all client hints (header, query, body)
      const hintSources: Array<[string, unknown]> = [
        ['header:x-space-id', request.headers?.['x-space-id']],
        ['header:x-project-id', request.headers?.['x-project-id']],
        ['query:spaceId', request.query?.spaceId],
        ['query:projectId', request.query?.projectId],
        ['body:spaceId', request.body?.spaceId],
        ['body:projectId', request.body?.projectId],
        ['body:project_id', request.body?.project_id],
      ];

      const resolvedHints: Array<{
        source: string;
        spaceId: string;
        isPersonal: boolean;
      }> = [];
      for (const [source, rawVal] of hintSources) {
        const res = await resolveSingleHint(rawVal);
        if (res.provided && res.spaceId && !res.isPersonal) {
          resolvedHints.push({
            source,
            spaceId: res.spaceId,
            isPersonal: false,
          });
        }
      }

      const distinctHintIds = Array.from(
        new Set(resolvedHints.map((h) => h.spaceId.toLowerCase())),
      );
      if (distinctHintIds.length > 1) {
        this.logger.warn(
          `Space context mismatch across client hints: ${resolvedHints
            .map((h) => `${h.source}=${h.spaceId}`)
            .join(', ')}`,
        );
        throw new ForbiddenException({
          statusCode: 403,
          code: 'PROJECT_CONTEXT_MISMATCH',
          message:
            'Conflicting project context hints between header, query, and body',
        });
      }

      const normalizedClientHint = resolvedHints[0]?.spaceId;

      const synchronizeRequestScope = (
        finalSpaceId: string | null,
        isPersonal: boolean,
      ) => {
        if (finalSpaceId) {
          request.resolvedSpaceId = finalSpaceId;
          request.spaceId = finalSpaceId;
          request.isPersonalSpace = isPersonal;
          request.resolvedProjectId = finalSpaceId;
          if (authoritativePageId) {
            request.resolvedPageId = authoritativePageId;
          } else if (pageId && isUUID(pageId)) {
            request.resolvedPageId = pageId;
          }
          if (request.query && 'projectId' in request.query) {
            request.query.projectId = finalSpaceId;
          }
          if (request.query && 'spaceId' in request.query) {
            request.query.spaceId = finalSpaceId;
          }
          if (
            request.body &&
            typeof request.body === 'object' &&
            'projectId' in request.body
          ) {
            request.body.projectId = finalSpaceId;
          }
          if (
            request.body &&
            typeof request.body === 'object' &&
            'spaceId' in request.body
          ) {
            request.body.spaceId = finalSpaceId;
          }
          if (
            request.body &&
            typeof request.body === 'object' &&
            'project_id' in request.body
          ) {
            request.body.project_id = finalSpaceId;
          }
          if (request.params && 'projectId' in request.params) {
            request.params.projectId = finalSpaceId;
          }
          if (request.params && 'spaceId' in request.params) {
            request.params.spaceId = finalSpaceId;
          }
        } else {
          if (currentUserId) {
            request.resolvedSpaceId = currentUserId;
            request.spaceId = currentUserId;
            request.isPersonalSpace = true;
          }
          delete request.resolvedProjectId;
          delete request.resolvedPageId;
          if (request.params && 'projectId' in request.params) {
            delete request.params.projectId;
          }
          if (request.params && 'spaceId' in request.params) {
            delete request.params.spaceId;
          }
          if (request.query && 'projectId' in request.query) {
            delete request.query.projectId;
          }
          if (request.query && 'spaceId' in request.query) {
            delete request.query.spaceId;
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
            'spaceId' in request.body
          ) {
            delete request.body.spaceId;
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

      // 9. Cross-check client hint with authoritative resource space
      if (authoritativeResourceSpaceId && normalizedClientHint) {
        if (
          authoritativeResourceSpaceId.toLowerCase() !==
          normalizedClientHint.toLowerCase()
        ) {
          this.logger.warn(
            `Space context mismatch: resource space (${authoritativeResourceSpaceId}) disagrees with client hint (${normalizedClientHint})`,
          );
          throw new ForbiddenException({
            statusCode: 403,
            code: 'PROJECT_CONTEXT_MISMATCH',
            message:
              'Resource does not belong to the requested project context',
          });
        }
      }

      // 10. Resolve from route path parameter :projectId / :spaceId
      const paramRes = await resolveSingleHint(
        request.params?.spaceId ?? request.params?.projectId,
      );
      const normalizedParamSpace =
        paramRes.provided && paramRes.spaceId ? paramRes.spaceId : undefined;

      if (
        authoritativeResourceSpaceId &&
        normalizedParamSpace &&
        !paramRes.isPersonal
      ) {
        if (
          authoritativeResourceSpaceId.toLowerCase() !==
          normalizedParamSpace.toLowerCase()
        ) {
          this.logger.warn(
            `Space context mismatch: resource space (${authoritativeResourceSpaceId}) disagrees with path param (${normalizedParamSpace})`,
          );
          throw new ForbiddenException({
            statusCode: 403,
            code: 'PROJECT_CONTEXT_MISMATCH',
            message:
              'Resource does not belong to the requested project context',
          });
        }
      }

      if (authoritativeResourceSpaceId) {
        const isPersonal = isUserPersonalSpaceId(authoritativeResourceSpaceId);
        // If resource belongs to another user's personal space (and is not a project), reject unless checked downstream
        if (isPersonal) {
          // For Library routes where personal space uses `projectId: null` semantics downstream,
          // keep `resolvedSpaceId = currentUserId` and return Personal Space context
          if (isLibraryContext) {
            synchronizeRequestScope(null, true);
            return null;
          }
          synchronizeRequestScope(authoritativeResourceSpaceId, true);
          return {
            projectId: authoritativeResourceSpaceId,
            spaceId: authoritativeResourceSpaceId,
            isPersonalSpace: true,
            source: 'resource',
          };
        }
        synchronizeRequestScope(authoritativeResourceSpaceId, false);
        return {
          projectId: authoritativeResourceSpaceId,
          spaceId: authoritativeResourceSpaceId,
          isPersonalSpace: false,
          source: 'resource',
        };
      }

      if (paramRes.provided && paramRes.isPersonal && currentUserId) {
        const url = request.url || request.raw?.url || '';
        const isPagesRoute =
          url.includes('/manuscripts') || url.includes('/pages');
        if (isPagesRoute) {
          synchronizeRequestScope(currentUserId, true);
          if (request.params && typeof request.params === 'object') {
            request.params.projectId = currentUserId;
            if ('spaceId' in request.params) {
              request.params.spaceId = currentUserId;
            }
          }
          if (request.query && typeof request.query === 'object') {
            request.query.projectId = currentUserId;
          }
          if (request.body && typeof request.body === 'object') {
            request.body.projectId = currentUserId;
          }
          return {
            projectId: currentUserId,
            spaceId: currentUserId,
            isPersonalSpace: true,
            source: 'param',
          };
        }
        if (isLibraryContext) {
          synchronizeRequestScope(null, true);
          return null;
        }
      }

      if (normalizedParamSpace && !paramRes.isPersonal) {
        if (
          normalizedClientHint &&
          normalizedParamSpace.toLowerCase() !==
            normalizedClientHint.toLowerCase()
        ) {
          this.logger.warn(
            `Space context mismatch: path param (${normalizedParamSpace}) disagrees with client hint (${normalizedClientHint})`,
          );
          throw new ForbiddenException({
            statusCode: 403,
            code: 'PROJECT_CONTEXT_MISMATCH',
            message:
              'Resource does not belong to the requested project context',
          });
        }
        synchronizeRequestScope(normalizedParamSpace, false);
        return {
          projectId: normalizedParamSpace,
          spaceId: normalizedParamSpace,
          isPersonalSpace: false,
          source: 'param',
        };
      }

      // 11. Fallback to client hint if no resource or path param was present
      if (normalizedClientHint) {
        synchronizeRequestScope(normalizedClientHint, false);
        return {
          projectId: normalizedClientHint,
          spaceId: normalizedClientHint,
          isPersonalSpace: false,
          source: 'hint',
        };
      }

      synchronizeRequestScope(null, true);
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
