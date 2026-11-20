import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { isUuid } from '@/core';
import { ExperimentNode } from './node.domain';
import { NodeRepository } from '../repositories/node.repository';

export type ExperimentAction = 'read' | 'write' | 'delete' | 'share';

const PERSONAL_SCOPE_ALIASES = new Set([
  'null',
  'undefined',
  'personal',
  'me',
  'user',
  'default',
  '',
]);

export function normalizeExperimentProjectId(
  projectId?: string | null,
  userId?: string,
): string | undefined {
  if (!projectId) return undefined;
  const trimmed = projectId.trim();
  if (PERSONAL_SCOPE_ALIASES.has(trimmed.toLowerCase())) {
    return undefined;
  }
  if (userId && trimmed === userId.trim()) {
    return undefined;
  }
  return trimmed;
}

@Injectable()
export class ExperimentsAccessPolicy {
  constructor(private readonly nodeRepo: NodeRepository) {}

  private assertProjectRoleAllows(
    rawRole: string,
    action: ExperimentAction,
  ): void {
    const role = rawRole.toLowerCase();
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
      `Project role ${rawRole} cannot perform ${action}`,
    );
  }

  async assertCanAccess(
    userId: string,
    nodeId: string,
    action: ExperimentAction,
    options?: { allowTrashed?: boolean },
  ): Promise<ExperimentNode> {
    const node = await this.nodeRepo.findById(nodeId);
    if (!node || (!options?.allowTrashed && node.isTrashed())) {
      throw new NotFoundException(
        'File or folder not found or has been trashed',
      );
    }

    if (node.authorId === userId) {
      return node;
    }

    const candidateFileIds = [nodeId];
    if (node.parentId && typeof this.nodeRepo.getFolderPath === 'function') {
      const ancestors = await this.nodeRepo.getFolderPath(node.parentId);
      for (const ancestor of ancestors) {
        if (ancestor.id && !candidateFileIds.includes(ancestor.id)) {
          candidateFileIds.push(ancestor.id);
        }
      }
    }

    const shares = await this.nodeRepo.findUserSharesForFiles(
      candidateFileIds,
      userId,
    );

    if (shares.length > 0) {
      if (action === 'read') return node;
      const hasEditPermission = shares.some((s) => s.permission === 'edit');
      if (action === 'write' && hasEditPermission) {
        return node;
      }
      throw new ForbiddenException('Insufficient permission for this file');
    }

    if (node.projectId) {
      const role = await this.nodeRepo.findProjectMemberRole(
        node.projectId,
        userId,
      );
      if (role !== null) {
        this.assertProjectRoleAllows(role, action);
        return node;
      }
    }

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

  async assertCanAccessProject(
    userId: string,
    projectId: string,
    action: ExperimentAction,
  ): Promise<void> {
    if (!userId) {
      throw new ForbiddenException(
        'Authentication required for project access',
      );
    }
    if (
      !projectId ||
      PERSONAL_SCOPE_ALIASES.has(projectId.trim().toLowerCase()) ||
      projectId.trim() === userId
    ) {
      return;
    }
    const trimmedProjectId = projectId.trim();
    if (!isUuid(trimmedProjectId)) {
      throw new BadRequestException('Invalid projectId: expected a valid UUID');
    }
    const role = await this.nodeRepo.findProjectMemberRole(
      trimmedProjectId,
      userId,
    );
    if (role === null) {
      const ownerUserId = this.nodeRepo.findSpaceOwnerId
        ? await this.nodeRepo.findSpaceOwnerId(trimmedProjectId).catch(() => null)
        : null;
      if (ownerUserId === userId) {
        return;
      }
      throw new ForbiddenException(
        'Access denied: you are not a member of this project',
      );
    }
    this.assertProjectRoleAllows(role, action);
  }

  async assertCanWriteScope(
    userId: string,
    options: {
      projectId?: string | null;
      parentId?: string | null;
    },
  ): Promise<void> {
    if (
      options.parentId &&
      options.parentId !== 'null' &&
      options.parentId !== 'root'
    ) {
      await this.assertCanAccess(userId, options.parentId, 'write');
    }
    const normalizedProjectId = normalizeExperimentProjectId(
      options.projectId,
      userId,
    );
    if (normalizedProjectId) {
      await this.assertCanAccessProject(userId, normalizedProjectId, 'write');
    }
  }
}
