import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '@/core';
import { StorageNode } from '../types';
import { IStorageNodeRepository } from '../repositories/prisma-node.repository';
import { STORAGE_NODE_REPOSITORY } from '@/modules/storage/storage.tokens';

export type StorageAction = 'read' | 'write' | 'delete' | 'share';

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

    const shares = await this.prisma.fileShare.findMany({
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
    if (!userId || !projectId) {
      throw new ForbiddenException('Authentication required for project access');
    }
    const membership = await this.prisma.projectMember.findUnique({
      where: {
        projectId_userId: { projectId, userId },
      },
    });
    if (!membership) {
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
    if (options.projectId && options.projectId !== 'null') {
      await this.assertCanAccessProject(userId, options.projectId, 'write');
    }
  }
}
