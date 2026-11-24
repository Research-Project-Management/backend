import {
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { getErrorMessage } from '@/core';
import { AI_ENGINE_PORT } from '../../ai.constant';
import { AccessService } from '../../access/services/access.service';
import type { ChatOwnershipRecord } from '../../access/types/access.type';
import type { IAiEnginePort } from '../../engine/engine.port';
import { encodeSseEvent } from '../../engine/domain/stream.mapper';
import type {
  EngineChatRequest,
  EngineChatResponse,
  StreamCompletionResult,
} from '../../engine/types/engine.type';
import {
  buildEngineChatRequest,
  extractNormalizedMessages,
} from '../domain/context.mapper';
import { deriveInitialChatTitle } from '../domain/title.domain';
import type { QueryDto, ResumeDto } from '../dto/query.dto';
import type { ExecuteChatResult } from '../types/chat.type';
import { SessionService } from './session.service';
import { TitleService } from './title.service';

export interface ChatTurnOptions {
  prependSystemMessage?: string;
  initialTitleHint?: string;
}

interface PreparedChatTurn {
  chatId: string;
  title: string;
  spaceId: string;
  userQuery: string;
  resolvedDocumentIds: string[];
  persistUserMsgPromise: Promise<unknown>;
  engineRequest: EngineChatRequest;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @Inject(AI_ENGINE_PORT)
    private readonly engine: IAiEnginePort,
    private readonly accessService: AccessService,
    private readonly sessionService: SessionService,
    private readonly titleService: TitleService,
  ) {}

  async stream(
    userId: string,
    dto: QueryDto,
    reply: FastifyReply,
    delegationToken?: string,
    options?: ChatTurnOptions,
  ): Promise<void> {
    const turn = await this.prepareChatTurn(
      userId,
      dto,
      delegationToken,
      options,
    );
    const initialFrames = [
      encodeSseEvent({ type: 'meta', chatId: turn.chatId, title: turn.title }),
    ];

    const onComplete = async (result: StreamCompletionResult) => {
      await turn.persistUserMsgPromise;
      const hasWidgets = Boolean(result.widgets && result.widgets.length > 0);
      if (result.cancelled || (!result.content.trim() && !hasWidgets)) return;

      await this.persistAssistantResponse({
        chatId: turn.chatId,
        userId,
        spaceId: turn.spaceId,
        userText: turn.userQuery,
        assistantText: this.resolveFallbackAssistantText(
          result.content,
          result.widgets,
        ),
        sources: result.sources,
        widgets: result.widgets,
        currentTitle: turn.title,
        documentIds: turn.resolvedDocumentIds,
      });
    };

    return this.engine.chatStream(turn.engineRequest, reply, {
      initialFrames,
      onComplete,
    });
  }

  async execute(
    userId: string,
    dto: QueryDto,
    delegationToken?: string,
    options?: ChatTurnOptions,
  ): Promise<ExecuteChatResult> {
    const turn = await this.prepareChatTurn(
      userId,
      dto,
      delegationToken,
      options,
    );
    await turn.persistUserMsgPromise;

    const response = await this.engine.chatSync(turn.engineRequest);

    if (
      response.content.trim() ||
      (response.widgets && response.widgets.length > 0)
    ) {
      await this.persistAssistantResponse({
        chatId: turn.chatId,
        userId,
        spaceId: turn.spaceId,
        userText: turn.userQuery,
        assistantText: this.resolveFallbackAssistantText(
          response.content,
          response.widgets,
        ),
        sources: response.sources,
        widgets: response.widgets,
        currentTitle: turn.title,
        documentIds: turn.resolvedDocumentIds,
      });
    }

    return {
      role: 'assistant',
      content: response.content,
      route: response.route,
      status: response.status,
      sources: response.sources,
      citations: response.citations,
      ...(response.widgets && response.widgets.length > 0
        ? { widgets: response.widgets }
        : {}),
      interrupts: response.interrupts,
      usage: response.usage,
      chatId: turn.chatId,
      title: turn.title,
      trace_id: response.trace_id,
    };
  }

  async resumeStream(
    userId: string,
    dto: ResumeDto,
    reply: FastifyReply,
    delegationToken?: string,
  ): Promise<void> {
    const engineRequest = await this.prepareResumeTurn(
      userId,
      dto,
      delegationToken,
    );

    return this.engine.resumeStream(engineRequest, reply, {
      onComplete: async (result) => {
        const hasWidgets = Boolean(result.widgets && result.widgets.length > 0);
        if (result.cancelled || (!result.content.trim() && !hasWidgets)) return;
        await this.sessionService
          .appendMessages(dto.chatId, userId, {
            messages: [
              {
                role: 'assistant',
                content: this.resolveFallbackAssistantText(
                  result.content,
                  result.widgets,
                ),
                ...(result.sources.length > 0
                  ? { sources: result.sources }
                  : {}),
                ...(hasWidgets ? { widgets: result.widgets } : {}),
              },
            ],
          })
          .catch((err: unknown) => {
            this.logger.warn(
              `Could not persist resumed stream assistant message: ${getErrorMessage(err)}`,
            );
          });
      },
    });
  }

  async resumeSync(
    userId: string,
    dto: ResumeDto,
    delegationToken?: string,
  ): Promise<EngineChatResponse> {
    const engineRequest = await this.prepareResumeTurn(
      userId,
      dto,
      delegationToken,
    );

    const response = await this.engine.resumeSync(engineRequest);

    if (
      response.content.trim() ||
      (response.widgets && response.widgets.length > 0)
    ) {
      await this.sessionService
        .appendMessages(dto.chatId, userId, {
          messages: [
            {
              role: 'assistant',
              content: this.resolveFallbackAssistantText(
                response.content,
                response.widgets,
              ),
              sources: response.sources,
              ...(response.widgets && response.widgets.length > 0
                ? { widgets: response.widgets }
                : {}),
            },
          ],
        })
        .catch((err: unknown) => {
          this.logger.warn(
            `Could not persist resumed sync assistant message: ${getErrorMessage(err)}`,
          );
        });
    }
    return response;
  }

  async cancel(userId: string, chatId: string, rawSpaceId?: string) {
    const scope = await this.accessService.authorizeChatTurn({
      userId,
      spaceId: rawSpaceId,
      chatId,
    });
    await this.engine.cancelThread(scope.spaceId, chatId);
    return { chatId, spaceId: scope.spaceId, status: 'cancelling' as const };
  }

  async revertTurn(
    userId: string,
    traceId: string,
    rawSpaceId?: string,
    authorization?: string,
    entityIds?: string[],
  ) {
    const scope = await this.accessService.resolveSpace(userId, rawSpaceId);
    return this.engine.revertTurn(
      traceId,
      scope.spaceId,
      authorization,
      entityIds,
    );
  }

  async listCheckpoints(
    userId: string,
    chatId: string,
    rawSpaceId?: string,
    limit?: number,
  ) {
    const scope = await this.accessService.authorizeChatTurn({
      userId,
      spaceId: rawSpaceId,
      chatId,
    });
    return this.engine.listThreadCheckpoints(chatId, scope.spaceId, limit);
  }

  async rewindThread(
    userId: string,
    chatId: string,
    checkpointId: string,
    rawSpaceId?: string,
    authorization?: string,
    revertTraceIds?: string[],
  ) {
    const cleanCheckpoint = (checkpointId || '').trim();
    if (!cleanCheckpoint) {
      throw new UnprocessableEntityException('checkpointId is required');
    }
    const scope = await this.accessService.authorizeChatTurn({
      userId,
      spaceId: rawSpaceId,
      chatId,
    });
    return this.engine.rewindThread(
      chatId,
      scope.spaceId,
      cleanCheckpoint,
      authorization,
      revertTraceIds,
    );
  }

  private async prepareChatTurn(
    userId: string,
    dto: QueryDto,
    delegationToken?: string,
    options?: ChatTurnOptions,
  ): Promise<PreparedChatTurn> {
    const normalized = extractNormalizedMessages(dto);
    const userMsgs = normalized.filter((m) => m.role === 'user');
    const lastUserMsg = userMsgs[userMsgs.length - 1];
    if (!lastUserMsg || !lastUserMsg.content.trim()) {
      throw new UnprocessableEntityException('Message content cannot be empty');
    }

    const turnAccess = await this.accessService.authorizeChatTurn({
      userId,
      spaceId: dto.spaceId,
      chatId: dto.chatId,
      pageId: dto.pageId,
      documentIds: dto.documentIds ?? [],
      attachedSources: dto.context?.attached_sources,
    });
    const enrichedSources = turnAccess.enrichedSources;

    const scopedDocSet = new Set<string>(turnAccess.resolvedDocumentIds);
    for (const source of enrichedSources) {
      if (source.source_id) {
        scopedDocSet.add(source.source_id);
      }
    }
    const scopedDocumentIds = Array.from(scopedDocSet);

    const effectiveDto: QueryDto =
      enrichedSources.length > 0
        ? {
            ...dto,
            context: {
              ...(dto.context && typeof dto.context === 'object'
                ? dto.context
                : {}),
              attached_sources: enrichedSources,
            },
          }
        : dto;

    const { chatId, title } = await this.resolveOrEstablishChat({
      userId,
      spaceId: dto.spaceId || turnAccess.spaceId,
      canonicalPageId: turnAccess.canonicalPageId,
      rawPageId: dto.pageId,
      existingChat: turnAccess.existingChat,
      userQuery: lastUserMsg.content,
      documentIds: scopedDocumentIds,
      initialTitleHint: options?.initialTitleHint,
    });

    const userAttachments = lastUserMsg.attachments ?? lastUserMsg.sources;
    const persistUserMsgPromise = this.sessionService
      .appendMessagesFast(chatId, userId, turnAccess.spaceId, {
        messages: [
          {
            role: 'user',
            content: lastUserMsg.content,
            ...(userAttachments !== undefined
              ? { sources: userAttachments }
              : {}),
          },
        ],
        documentIds: scopedDocumentIds,
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `Could not persist user message: ${getErrorMessage(err)}`,
        );
      });

    const engineRequest = buildEngineChatRequest({
      userId,
      spaceId: turnAccess.spaceId,
      projectId: turnAccess.projectId,
      chatId,
      pageId: turnAccess.canonicalPageId ?? dto.pageId,
      documentIds: scopedDocumentIds,
      dto: effectiveDto,
      prependSystemMessage: options?.prependSystemMessage,
      delegationToken,
      llmOverride: turnAccess.llmOverride,
    });

    return {
      chatId,
      title,
      spaceId: turnAccess.spaceId,
      userQuery: lastUserMsg.content,
      resolvedDocumentIds: scopedDocumentIds,
      persistUserMsgPromise,
      engineRequest,
    };
  }

  private async prepareResumeTurn(
    userId: string,
    dto: ResumeDto,
    delegationToken?: string,
  ) {
    const turnAccess = await this.accessService.authorizeChatTurn({
      userId,
      spaceId: dto.spaceId,
      chatId: dto.chatId,
      pageId: dto.pageId,
      documentIds: dto.documentIds,
    });

    return {
      decision: dto.decision,
      space_id: turnAccess.spaceId,
      chat_id: dto.chatId,
      page_id: turnAccess.canonicalPageId ?? dto.pageId ?? null,
      document_ids: turnAccess.resolvedDocumentIds,
      ...(delegationToken ? { delegation_token: delegationToken } : {}),
    };
  }

  private async persistAssistantResponse(params: {
    chatId: string;
    userId: string;
    spaceId: string;
    userText: string;
    assistantText: string;
    sources: unknown[];
    widgets?: unknown[];
    currentTitle: string;
    documentIds: string[];
  }): Promise<void> {
    try {
      await this.sessionService.appendMessagesFast(
        params.chatId,
        params.userId,
        params.spaceId,
        {
          messages: [
            {
              role: 'assistant',
              content: params.assistantText,
              ...(params.sources.length > 0 ? { sources: params.sources } : {}),
              ...(params.widgets && params.widgets.length > 0
                ? { widgets: params.widgets }
                : {}),
            },
          ],
          documentIds: params.documentIds,
        },
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Could not persist assistant message: ${getErrorMessage(err)}`,
      );
    }

    void this.titleService.maybeGenerateTitle({
      chatId: params.chatId,
      userId: params.userId,
      spaceId: params.spaceId,
      userText: params.userText,
      assistantText: params.assistantText,
      currentTitle: params.currentTitle,
      documentIds: params.documentIds,
    });
  }

  private resolveFallbackAssistantText(
    content: string,
    widgets?: unknown[],
  ): string {
    if (content.trim()) return content;
    const hasEditorPatches = Boolean(
      widgets?.some(
        (w) =>
          w &&
          typeof w === 'object' &&
          (w as Record<string, unknown>).type === 'editor_patches',
      ),
    );
    return hasEditorPatches
      ? 'Proposed manuscript edits ready for review.'
      : 'Workspace summary ready.';
  }

  private async resolveOrEstablishChat(params: {
    userId: string;
    spaceId?: string;
    canonicalPageId?: string;
    rawPageId?: string;
    existingChat: ChatOwnershipRecord | null;
    userQuery: string;
    documentIds: string[];
    initialTitleHint?: string;
  }): Promise<{ chatId: string; title: string }> {
    if (params.existingChat) {
      return {
        chatId: params.existingChat.id,
        title: params.existingChat.title,
      };
    }

    const hint = params.initialTitleHint?.trim();
    const initialTitle =
      hint || deriveInitialChatTitle(params.userQuery, params.documentIds);
    const created = await this.sessionService.createChat(params.userId, {
      spaceId: params.spaceId,
      pageId: params.canonicalPageId || params.rawPageId,
      title: initialTitle,
      documentIds: params.documentIds,
    });
    return { chatId: created.id, title: created.title };
  }
}
