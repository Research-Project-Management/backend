import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { getErrorMessage } from '@/core';
import { AI_ENGINE_PORT } from '../../ai.constant';
import type { IAiEnginePort } from '../../engine/engine.port';
import { ChatRepository } from '../chat.repository';
import {
  cleanGeneratedTitle,
  extractHeuristicTitle,
  isGenericChatTitle,
  sanitizeChatTitle,
} from '../domain/title.domain';
import { SessionService } from './session.service';

@Injectable()
export class TitleService {
  private readonly logger = new Logger(TitleService.name);

  constructor(
    private readonly chatRepo: ChatRepository,
    private readonly sessionService: SessionService,
    @Optional()
    @Inject(AI_ENGINE_PORT)
    private readonly engine?: IAiEnginePort,
  ) {}

  async maybeGenerateTitle(params: {
    chatId: string;
    userId: string;
    spaceId: string;
    userText: string;
    assistantText: string;
    currentTitle?: string;
    documentIds?: string[];
  }): Promise<void> {
    try {
      if (!isGenericChatTitle(params.currentTitle)) return;

      if (params.documentIds && params.documentIds.length > 0) {
        const docName = await this.chatRepo.findFirstDocumentFilename(
          params.documentIds,
        );
        if (docName) {
          const cleanDocTitle = sanitizeChatTitle(docName).slice(0, 45);
          await this.sessionService.renameChat(params.chatId, params.userId, {
            title: `Tài liệu: ${cleanDocTitle}`,
          });
          return;
        }
      }

      if (this.engine) {
        const prompt =
          'Generate a concise, professional title (3 to 6 words maximum, in the same language as the conversation, no quotes, no trailing punctuation) ' +
          `summarizing the main topic:\n\nUser: ${params.userText.slice(0, 400)}\nAssistant: ${params.assistantText.slice(0, 600)}`;

        const res = await this.engine.chatSync({
          messages: [{ role: 'user', content: prompt }],
          space_id: params.spaceId,
          stateless: true,
          intent_hint: 'direct',
        });

        const cleaned = cleanGeneratedTitle(res.content || '');
        if (cleaned) {
          await this.sessionService.renameChat(params.chatId, params.userId, {
            title: cleaned,
          });
          return;
        }
      }

      const heuristic = extractHeuristicTitle(
        params.userText,
        params.assistantText,
      );
      if (heuristic && heuristic !== params.currentTitle) {
        await this.sessionService.renameChat(params.chatId, params.userId, {
          title: heuristic,
        });
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Could not auto-generate chat title: ${getErrorMessage(err)}`,
      );
    }
  }
}
