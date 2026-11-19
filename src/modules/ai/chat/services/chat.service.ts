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
  ): Promise<void> {
    const turn = await this.prepareChatTurn(userId, dto, delegationToken);
    const initialFrames = [
      `data: [META]${JSON.stringify({ chatId: turn.chatId, title: turn.title })}\n\n`,
    ];

    const onComplete = async (result: StreamCompletionResult) => {
      await turn.persistUserMsgPromise;
      if (result.cancelled || !result.content.trim()) return;

      await this.persistAssistantResponse({
        chatId: turn.chatId,
        userId,
        spaceId: turn.spaceId,
        userText: turn.userQuery,
        assistantText: result.content,
        sources: result.sources,
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
  ): Promise<ExecuteChatResult> {
    const turn = await this.prepareChatTurn(userId, dto, delegationToken);
    await turn.persistUserMsgPromise;

    const response = await this.engine.chatSync(turn.engineRequest);

    if (response.content.trim()) {
      await this.persistAssistantResponse({
        chatId: turn.chatId,
        userId,
        spaceId: turn.spaceId,
        userText: turn.userQuery,
        assistantText: response.content,
        sources: response.sources,
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
        if (result.cancelled || !result.content.trim()) return;
        await this.sessionService
          .appendMessages(dto.chatId, userId, {
            messages: [
              {
                role: 'assistant',
                content: result.content,
                ...(result.sources.length > 0
                  ? { sources: result.sources }
                  : {}),
              },
            ],
          })
          .catch(() => undefined);
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

    if (response.content.trim()) {
      await this.sessionService
        .appendMessages(dto.chatId, userId, {
          messages: [
            {
              role: 'assistant',
              content: response.content,
              sources: response.sources,
            },
          ],
        })
        .catch(() => undefined);
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

  private async prepareChatTurn(
    userId: string,
    dto: QueryDto,
    delegationToken?: string,
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
    });

    const { chatId, title } = await this.resolveOrEstablishChat({
      userId,
      spaceId: dto.spaceId || turnAccess.spaceId,
      canonicalPageId: turnAccess.canonicalPageId,
      rawPageId: dto.pageId,
      existingChat: turnAccess.existingChat,
      userQuery: lastUserMsg.content,
      documentIds: turnAccess.resolvedDocumentIds,
    });

    const userAttachments = lastUserMsg.attachments ?? lastUserMsg.sources;
    const persistUserMsgPromise = this.sessionService
      .appendMessages(chatId, userId, {
        messages: [
          {
            role: 'user',
            content: lastUserMsg.content,
            ...(userAttachments !== undefined
              ? { sources: userAttachments }
              : {}),
          },
        ],
        documentIds: turnAccess.resolvedDocumentIds,
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `Could not persist user message: ${getErrorMessage(err)}`,
        );
      });

    const engineRequest = buildEngineChatRequest({
      userId,
      spaceId: turnAccess.spaceId,
      chatId,
      pageId: turnAccess.canonicalPageId ?? dto.pageId,
      documentIds: turnAccess.resolvedDocumentIds,
      dto,
      delegationToken,
    });

    return {
      chatId,
      title,
      spaceId: turnAccess.spaceId,
      userQuery: lastUserMsg.content,
      resolvedDocumentIds: turnAccess.resolvedDocumentIds,
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
    currentTitle: string;
    documentIds: string[];
  }): Promise<void> {
    try {
      await this.sessionService.appendMessages(params.chatId, params.userId, {
        messages: [
          {
            role: 'assistant',
            content: params.assistantText,
            ...(params.sources.length > 0 ? { sources: params.sources } : {}),
          },
        ],
        documentIds: params.documentIds,
      });
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

  private async resolveOrEstablishChat(params: {
    userId: string;
    spaceId?: string;
    canonicalPageId?: string;
    rawPageId?: string;
    existingChat: ChatOwnershipRecord | null;
    userQuery: string;
    documentIds: string[];
  }): Promise<{ chatId: string; title: string }> {
    if (params.rawPageId) {
      const pageChat = await this.sessionService.getOrCreatePageChat(
        params.canonicalPageId || params.rawPageId,
        params.userId,
        params.spaceId,
      );
      return { chatId: pageChat.id, title: pageChat.title };
    }

    if (params.existingChat) {
      return {
        chatId: params.existingChat.id,
        title: params.existingChat.title,
      };
    }

    const initialTitle = deriveInitialChatTitle(
      params.userQuery,
      params.documentIds,
    );
    const created = await this.sessionService.createChat(params.userId, {
      spaceId: params.spaceId,
      title: initialTitle,
      documentIds: params.documentIds,
    });
    return { chatId: created.id, title: created.title };
  }
}
