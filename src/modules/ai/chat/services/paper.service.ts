import { Inject, Injectable, Optional } from '@nestjs/common';
import * as crypto from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { RedisCacheService } from '@/core';
import { AI_ENGINE_PORT, AI_REDIS_KEYS } from '../../ai.constant';
import { AccessService } from '../../access/services/access.service';
import type { IAiEnginePort } from '../../engine/engine.port';
import type {
  EngineChatRequest,
  EngineChatResponse,
} from '../../engine/types/engine.type';
import {
  buildEngineChatRequest,
  extractNormalizedMessages,
  formatPaperGroundingPrompt,
} from '../domain/context.mapper';
import type { QueryDto } from '../dto/query.dto';

@Injectable()
export class PaperChatService {
  constructor(
    @Inject(AI_ENGINE_PORT)
    private readonly engine: IAiEnginePort,
    private readonly accessService: AccessService,
    @Optional() private readonly redis?: RedisCacheService,
  ) {}

  async stream(
    userId: string,
    paperId: string,
    dto: QueryDto,
    reply: FastifyReply,
    delegationToken?: string,
  ): Promise<void> {
    const { engineRequest } = await this.preparePaperTurn(
      userId,
      paperId,
      dto,
      delegationToken,
    );
    return this.engine.chatStream(engineRequest, reply);
  }

  async execute(
    userId: string,
    paperId: string,
    dto: QueryDto,
    delegationToken?: string,
  ): Promise<EngineChatResponse> {
    const { spaceId, ragDocId, engineRequest } = await this.preparePaperTurn(
      userId,
      paperId,
      dto,
      delegationToken,
    );

    const normalizedMsgs = extractNormalizedMessages(dto);
    const cleanQuery = (
      normalizedMsgs[normalizedMsgs.length - 1]?.content || ''
    ).trim();

    if (this.redis && cleanQuery) {
      const queryHash = crypto
        .createHash('sha256')
        .update(cleanQuery)
        .digest('hex');
      const cacheKey = AI_REDIS_KEYS.paperQa(
        spaceId,
        ragDocId || paperId,
        queryHash,
      );
      return this.redis.wrap(
        cacheKey,
        () => this.engine.chatSync(engineRequest),
        3600,
      );
    }

    return this.engine.chatSync(engineRequest);
  }

  private async preparePaperTurn(
    userId: string,
    paperId: string,
    dto: QueryDto,
    delegationToken?: string,
  ): Promise<{
    spaceId: string;
    ragDocId: string | null;
    engineRequest: EngineChatRequest;
  }> {
    const resolved = await this.accessService.resolvePaperTarget(
      userId,
      paperId,
    );
    await this.accessService.verifyChatOwnership(userId, dto.chatId);

    const chatId = dto.chatId || `paper-${paperId}-${userId}`;
    const paperContext = formatPaperGroundingPrompt(resolved);
    const scopedDocIds = resolved.ragDocId ? [resolved.ragDocId] : [];

    const engineRequest = buildEngineChatRequest({
      userId,
      spaceId: resolved.spaceId,
      chatId,
      documentIds: scopedDocIds,
      dto: { ...dto, intentHint: 'rag_agent' },
      prependSystemMessage: paperContext,
      delegationToken,
    });

    return {
      spaceId: resolved.spaceId,
      ragDocId: resolved.ragDocId,
      engineRequest,
    };
  }
}
