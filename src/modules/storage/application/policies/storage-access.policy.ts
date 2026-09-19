import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { StorageNode } from '../../domain/entities/storage-node.entity';
import { IStorageNodeRepository } from '../../domain/ports/storage-node.repository.port';
import { Inject } from '@nestjs/common';
import { STORAGE_NODE_REPOSITORY } from '../../storage.tokens';

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
   * 2. Direct FileShare ACL
   * 3. Project Workbench RBAC
   * 4. Contextual metadata (Embargo date / isPublic)
   */
  async assertCanAccess(
    userId: string,
    nodeId: string,
    action: StorageAction,
  ): Promise<StorageNode> {
    const node = await this.nodeRepo.findById(nodeId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException(
        'File or folder not found or has been trashed',
      );
    }

    // 1. Author / Owner bypass
    if (node.authorId === userId) {
      return node;
    }

    // 2. Direct FileShare ACL
    const directShare = await this.prisma.fileShare.findUnique({
      where: {
        fileId_userId: { fileId: nodeId, userId },
      },
    });

    if (directShare) {
      if (action === 'read') return node;
      if (action === 'write' && directShare.permission === 'edit') return node;
      throw new ForbiddenException('Insufficient permission for this file');
    }

    // 3. Project Workbench RBAC check
    if (node.scope === 'Project' && node.projectId) {
      const membership = await this.prisma.projectMember.findUnique({
        where: {
          projectId_userId: { projectId: node.projectId, userId },
        },
      });

      if (membership) {
        if (action === 'read') return node;
        if (
          action === 'write' &&
          ['owner', 'coordinator', 'contributor'].includes(membership.role)
        )
          return node;
        if (action === 'delete' && membership.role === 'owner') return node;
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
}
