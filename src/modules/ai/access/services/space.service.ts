import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccessRepository } from '../access.repository';
import { assertPersonalSpaceOwnership } from '../domain/access.policy';
import { isValidUuid, normalizeScopeAlias } from '../domain/scope.mapper';
import type {
  ChatOwnershipRecord,
  ResolvedPageScope,
  ResolvedSpaceScope,
} from '../types/access.type';

@Injectable()
export class SpaceAccessService {
  constructor(private readonly repo: AccessRepository) {}

  async resolveSpace(
    userId: string,
    rawSpaceId?: string | null,
  ): Promise<ResolvedSpaceScope> {
    const cleanAlias = normalizeScopeAlias(rawSpaceId, userId);
    if (!cleanAlias) {
      const personalSpace = await this.repo.findPersonalSpace(userId);
      return {
        spaceId: personalSpace?.id || userId,
        projectId: null,
      };
    }

    const space = await this.repo.findSpaceByIdOrProjectId(cleanAlias);
    if (space) {
      if (space.type === 'personal') {
        assertPersonalSpaceOwnership(space, userId);
        return { spaceId: space.id, projectId: null };
      }
      if (space.projectId) {
        const project = await this.repo.findAccessibleProject(
          space.projectId,
          userId,
        );
        if (!project) {
          throw new ForbiddenException(
            'You do not have access to this project',
          );
        }
        return { spaceId: space.id, projectId: project.id };
      }
    }

    const project = await this.repo.findAccessibleProject(cleanAlias, userId);
    if (!project) {
      throw new ForbiddenException('You do not have access to this project');
    }

    return {
      spaceId: project.spaceId || project.id,
      projectId: project.id,
    };
  }

  async resolvePageScope(
    userId: string,
    pageId: string,
    fallbackSpaceId?: string | null,
  ): Promise<ResolvedPageScope> {
    const record = await this.repo.findPageOrDoc(pageId);
    if (this.repo.hasPageLookup() && !record) {
      throw new NotFoundException('Manuscript page not found');
    }

    const canonicalPageId = record?.canonicalPageId || pageId;
    const rawSpaceId = record?.spaceId ?? fallbackSpaceId;
    const resolvedSpace = await this.resolveSpace(userId, rawSpaceId);

    return {
      canonicalPageId,
      spaceId: resolvedSpace.spaceId,
      projectId: resolvedSpace.projectId,
      titleHint: record?.titleHint ?? null,
    };
  }

  async verifyChatOwnership(
    userId: string,
    chatId?: string,
  ): Promise<ChatOwnershipRecord | null> {
    if (!chatId || !isValidUuid(chatId)) return null;
    const chat = await this.repo.findChatOwnership(chatId);
    if (chat && chat.createdById !== userId) {
      throw new ForbiddenException(
        'You do not have access to this chat session',
      );
    }
    return chat;
  }

  async hasSpaceOrProjectAccess(
    userId: string,
    spaceOrProjectId?: string | null,
  ): Promise<boolean> {
    if (!spaceOrProjectId || spaceOrProjectId === userId) {
      return true;
    }

    const space = await this.repo.findSpaceByIdOrProjectId(spaceOrProjectId);
    if (space) {
      if (space.type === 'personal') {
        return !space.ownerUserId || space.ownerUserId === userId;
      }
      if (space.projectId) {
        const byProject = await this.repo.findAccessibleProject(
          space.projectId,
          userId,
        );
        if (byProject) return true;
        return this.repo.isProjectMember(space.projectId, userId);
      }
    }

    if (await this.repo.isProjectMember(spaceOrProjectId, userId)) {
      return true;
    }
    const project = await this.repo.findAccessibleProject(
      spaceOrProjectId,
      userId,
    );
    return project !== null;
  }
}
