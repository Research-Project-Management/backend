import { Injectable } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AccessService } from '../../access/services/access.service';
import type { EnrichedAttachedSource } from '../../access/types/access.type';
import { formatPaperGroundingPrompt } from '../domain/context.mapper';
import type { QueryDto } from '../dto/query.dto';
import type { ExecuteChatResult } from '../types/chat.type';
import { ChatService, type ChatTurnOptions } from './chat.service';

/**
 * Paper-context adapter that resolves a target Library paper/file into
 * authoritative grounding context and delegates turn execution & persistence
 * to the single canonical `ChatService` pipeline.
 */
@Injectable()
export class PaperChatService {
  constructor(
    private readonly chatService: ChatService,
    private readonly accessService: AccessService,
  ) {}

  async stream(
    userId: string,
    paperId: string,
    dto: QueryDto,
    reply: FastifyReply,
    delegationToken?: string,
  ): Promise<void> {
    const { effectiveDto, turnOptions } = await this.buildPaperTurnInput(
      userId,
      paperId,
      dto,
    );
    return this.chatService.stream(
      userId,
      effectiveDto,
      reply,
      delegationToken,
      turnOptions,
    );
  }

  async execute(
    userId: string,
    paperId: string,
    dto: QueryDto,
    delegationToken?: string,
  ): Promise<ExecuteChatResult> {
    const { effectiveDto, turnOptions } = await this.buildPaperTurnInput(
      userId,
      paperId,
      dto,
    );
    return this.chatService.execute(
      userId,
      effectiveDto,
      delegationToken,
      turnOptions,
    );
  }

  private async buildPaperTurnInput(
    userId: string,
    paperId: string,
    dto: QueryDto,
  ): Promise<{
    effectiveDto: QueryDto;
    turnOptions: ChatTurnOptions;
  }> {
    const resolved = await this.accessService.resolvePaperTarget(
      userId,
      paperId,
    );

    const effectiveSourceId = resolved.ragDocId || resolved.fileId || null;
    const mergedDocIds = Array.from(
      new Set([
        ...(effectiveSourceId ? [effectiveSourceId] : []),
        ...(dto.documentIds ?? []),
      ]),
    );
    const paperItemId = resolved.itemId ?? paperId;

    const authoritativeSource: EnrichedAttachedSource = {
      kind: 'paper',
      title: resolved.title,
      source_id: effectiveSourceId,
      source_type: 'file',
      item_id: paperItemId,
      file_id: resolved.fileId ?? null,
      has_pdf: Boolean(resolved.fileId),
      indexed: Boolean(resolved.ragDocId),
    };

    const existingSources = Array.isArray(dto.context?.attached_sources)
      ? (dto.context.attached_sources as unknown[])
      : [];
    const dedupedRest = existingSources.filter((entry) => {
      if (!entry || typeof entry !== 'object') return true;
      const rec = entry as Record<string, unknown>;
      const entryIds = [
        rec.item_id,
        rec.itemId,
        rec.source_id,
        rec.sourceId,
        rec.id,
      ]
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map((v) => v.trim());
      return (
        !entryIds.includes(paperId) &&
        !entryIds.includes(paperItemId) &&
        (!resolved.fileId || !entryIds.includes(resolved.fileId)) &&
        (!resolved.ragDocId || !entryIds.includes(resolved.ragDocId))
      );
    });

    const effectiveDto: QueryDto = {
      ...dto,
      spaceId: dto.spaceId || resolved.spaceId,
      documentIds: mergedDocIds,
      context: {
        ...(dto.context && typeof dto.context === 'object' ? dto.context : {}),
        attached_sources: [authoritativeSource, ...dedupedRest],
      },
    };

    return {
      effectiveDto,
      turnOptions: {
        prependSystemMessage: formatPaperGroundingPrompt(resolved),
        initialTitleHint: resolved.title,
      },
    };
  }
}
