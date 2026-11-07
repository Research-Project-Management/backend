import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import { StorageNode } from '../types';
import { IStorageNodeRepository } from '../repositories/prisma-node.repository';
import { STORAGE_NODE_REPOSITORY } from '@/modules/storage/storage.tokens';

export type StorageAction = 'read' | 'write' | 'delete' | 'share';

const STORAGE_PERSONAL_ALIASES = new Set([
  'null',
  'undefined',
  'personal',
  'me',
  'user',
  'default',
  '',
]);

export function normalizeStorageProjectId(
  projectId?: string | null,
  userId?: string,
): string | undefined {
  if (!projectId) return undefined;
  const trimmed = projectId.trim();
  if (STORAGE_PERSONAL_ALIASES.has(trimmed.toLowerCase())) {
    return undefined;
  }
  if (userId && trimmed === userId.trim()) {
    return undefined;
  }
  return trimmed;
}

@Injectable()
export class StorageAccessPolicy {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
  ) {}

  /**
   * Evaluates 5-tier ReBAC access permissions:
   * 1. Author bypass (Full access)
   * 2. Direct & Ancestor Folder FileShare ACL (Single batched query)
   * 3. Project Workbench RBAC (across Project, Page, and Library scopes)
   * 4. Contextual metadata (Embargo date / isPublic)
   */
  async assertCanAccess(
    userId: string,
    nodeId: string,
    action: StorageAction,
    options?: { allowTrashed?: boolean },
  ): Promise<StorageNode> {
    const node = await this.nodeRepo.findById(nodeId);
    if (!node || (!options?.allowTrashed && node.isTrashed())) {
      throw new NotFoundException(
        'File or folder not found or has been trashed',
      );
    }

    // 1. Author / Owner bypass
    if (node.authorId === userId) {
      return node;
    }

    // 2. Direct & Ancestor Folder FileShare ACL (Batched to avoid N+1 queries)
    const candidateFileIds = [nodeId];
    if (node.parentId && typeof this.nodeRepo.getFolderPath === 'function') {
      const ancestors = await this.nodeRepo.getFolderPath(node.parentId);
      for (const ancestor of ancestors) {
        if (ancestor.id && !candidateFileIds.includes(ancestor.id)) {
          candidateFileIds.push(ancestor.id);
        }
      }
    }

    const shares = await this.prisma.storageFileShare.findMany({
      where: {
        fileId: { in: candidateFileIds },
        userId,
      },
    });

    if (shares.length > 0) {
      if (action === 'read') return node;
      const hasEditPermission = shares.some((s) => s.permission === 'edit');
      if (action === 'write' && hasEditPermission) {
        return node;
      }
      throw new ForbiddenException('Insufficient permission for this file');
    }

    // 3. Project Workbench RBAC check (across Project, Page, and Library scopes)
    if (node.projectId) {
      const membership = await this.prisma.projectMember.findUnique({
        where: {
          projectId_userId: { projectId: node.projectId, userId },
        },
      });

      if (membership) {
        const role = String(membership.role || '').toLowerCase();
        if (action === 'read') return node;
        if (
          action === 'write' &&
          ['owner', 'coordinator', 'contributor'].includes(role)
        )
          return node;
        if (
          (action === 'delete' || action === 'share') &&
          ['owner', 'coordinator'].includes(role)
        )
          return node;
        throw new ForbiddenException(
          `Project role ${membership.role} cannot perform ${action}`,
        );
      }
    }

    // 4. Academic Embargo & Public access check
    const metadata = node.metadata as {
      embargoUntil?: string;
      isPublic?: boolean;
    };
    if (
      metadata?.isPublic &&
      (!metadata.embargoUntil || new Date(metadata.embargoUntil) <= new Date())
    ) {
      if (action === 'read') return node;
    }

    throw new ForbiddenException(
      'Access denied: you do not have permission to access this resource',
    );
  }

  /**
   * Verifies that a user has RBAC permission on a project scope.
   */
  async assertCanAccessProject(
    userId: string,
    projectId: string,
    action: StorageAction,
  ): Promise<void> {
    if (!userId) {
      throw new ForbiddenException('Authentication required for project access');
    }
    if (
      !projectId ||
      STORAGE_PERSONAL_ALIASES.has(projectId.trim().toLowerCase()) ||
      projectId.trim() === userId
    ) {
      return;
    }
    const trimmedProjectId = projectId.trim();
    if (!isUuid(trimmedProjectId)) {
      throw new BadRequestException('Invalid projectId: expected a valid UUID');
    }
    const membership = await this.prisma.projectMember.findUnique({
      where: {
        projectId_userId: { projectId: trimmedProjectId, userId },
      },
    });
    if (!membership) {
      const [space, page] = await Promise.all([
        this.prisma.space?.findUnique
          ? Promise.resolve(
              this.prisma.space.findUnique({
                where: { id: trimmedProjectId },
                select: { ownerUserId: true },
              }),
            ).catch(() => null)
          : Promise.resolve(null),
        this.prisma.page?.findUnique
          ? Promise.resolve(
              this.prisma.page.findUnique({
                where: { id: trimmedProjectId },
                select: { spaceId: true, createdById: true },
              }),
            ).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (
        space?.ownerUserId === userId ||
        page?.spaceId === userId ||
        page?.createdById === userId
      ) {
        return;
      }
      throw new ForbiddenException(
        'Access denied: you are not a member of this project',
      );
    }
    const role = String(membership.role || '').toLowerCase();
    if (action === 'read') return;
    if (
      action === 'write' &&
      ['owner', 'coordinator', 'contributor'].includes(role)
    ) {
      return;
    }
    if (
      (action === 'delete' || action === 'share') &&
      ['owner', 'coordinator'].includes(role)
    ) {
      return;
    }
    throw new ForbiddenException(
      `Project role ${membership.role} cannot perform ${action}`,
    );
  }

  /**
   * Verifies that a user can access a page or parent folder when listing or creating nodes.
   */
  async assertCanWriteScope(
    userId: string,
    options: {
      projectId?: string | null;
      parentId?: string | null;
    },
  ): Promise<void> {
    if (options.parentId && options.parentId !== 'null' && options.parentId !== 'root') {
      await this.assertCanAccess(userId, options.parentId, 'write');
    }
    const normalizedProjectId = normalizeStorageProjectId(
      options.projectId,
      userId,
    );
    if (normalizedProjectId) {
      await this.assertCanAccessProject(userId, normalizedProjectId, 'write');
    }
  }
}
