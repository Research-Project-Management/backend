import { Injectable, Optional } from '@nestjs/common';
import { AccessRepository } from '../access.repository';
import type {
  ChatOwnershipRecord,
  ChatTurnAccess,
  ResolvedChatDocuments,
  ResolvedPageScope,
  ResolvedPaperTarget,
  ResolvedSpaceScope,
} from '../types/access.type';
import { DocumentAccessService } from './document.service';
import { SpaceAccessService } from './space.service';

@Injectable()
export class AccessService {
  constructor(
    private readonly spaceAccess: SpaceAccessService,
    private readonly documentAccess: DocumentAccessService,
    @Optional() private readonly repo?: AccessRepository,
  ) {}

  resolveSpace(
    userId: string,
    rawSpaceId?: string | null,
  ): Promise<ResolvedSpaceScope> {
    return this.spaceAccess.resolveSpace(userId, rawSpaceId);
  }

  resolvePageScope(
    userId: string,
    pageId: string,
    fallbackSpaceId?: string | null,
  ): Promise<ResolvedPageScope> {
    return this.spaceAccess.resolvePageScope(userId, pageId, fallbackSpaceId);
  }

  verifyChatOwnership(
    userId: string,
    chatId?: string,
  ): Promise<ChatOwnershipRecord | null> {
    return this.spaceAccess.verifyChatOwnership(userId, chatId);
  }

  resolvePaperTarget(
    userId: string,
    paperOrFileId: string,
  ): Promise<ResolvedPaperTarget> {
    return this.documentAccess.resolvePaperTarget(userId, paperOrFileId);
  }

  async authorizeChatTurn(params: {
    userId: string;
    spaceId?: string | null;
    chatId?: string;
    pageId?: string;
    documentIds?: string[];
    attachedSources?: unknown;
  }): Promise<ChatTurnAccess> {
    const hasScopedDocs =
      (params.documentIds && params.documentIds.length > 0) ||
      Array.isArray(params.attachedSources);

    const [existingChat, resolvedDocs, scope, llmOverride] =
      await Promise.all([
        this.spaceAccess.verifyChatOwnership(params.userId, params.chatId),
        hasScopedDocs
          ? this.documentAccess.resolveChatDocuments(
              params.documentIds ?? [],
              params.attachedSources,
            )
          : Promise.resolve<ResolvedChatDocuments>({
              resolvedDocumentIds: [],
              enrichedSources: [],
            }),
        params.pageId
          ? this.spaceAccess.resolvePageScope(
              params.userId,
              params.pageId,
              params.spaceId,
            )
          : this.spaceAccess.resolveSpace(params.userId, params.spaceId),
        this.repo
          ? this.repo.findUserLlmOverride(params.userId)
          : Promise.resolve(null),
      ]);

    const pageScope =
      params.pageId &&
      typeof (scope as Partial<ResolvedPageScope>).canonicalPageId === 'string'
        ? (scope as ResolvedPageScope)
        : null;

    return {
      spaceId: scope.spaceId,
      projectId: scope.projectId,
      canonicalPageId: pageScope?.canonicalPageId,
      titleHint: pageScope?.titleHint,
      resolvedDocumentIds: resolvedDocs.resolvedDocumentIds,
      enrichedSources: resolvedDocs.enrichedSources,
      existingChat,
      ...(llmOverride ? { llmOverride } : {}),
    };
  }
}
