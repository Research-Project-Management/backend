import { Inject, Injectable, Optional } from '@nestjs/common';
import { AI_ENGINE_PORT } from './ai.constant';
import type {
  AiAuthorizedScope,
  AiAuthorizeScopeParams,
  AiGenerateParams,
  AiGenerateResult,
  AiHealthStatus,
  IAiFacade,
} from './ai.type';
import { AccessService } from './access/services/access.service';
import type { IAiEnginePort } from './engine/engine.port';
import type { EngineMessage } from './engine/types/engine.type';

@Injectable()
export class AiFacade implements IAiFacade {
  constructor(
    @Inject(AI_ENGINE_PORT)
    private readonly engine: IAiEnginePort,
    @Optional()
    private readonly accessService?: AccessService,
  ) {}

  async authorizeScope(
    params: AiAuthorizeScopeParams,
  ): Promise<AiAuthorizedScope> {
    if (!params.userId || !this.accessService) {
      return { spaceId: params.spaceId, pageId: params.pageId };
    }

    const cleanPageId = params.pageId?.trim();
    const cleanSpaceId = params.spaceId?.trim();

    if (cleanPageId) {
      const pageScope = await this.accessService.resolvePageScope(
        params.userId,
        cleanPageId,
        cleanSpaceId,
      );
      return {
        spaceId: pageScope.spaceId,
        pageId: pageScope.canonicalPageId,
      };
    }

    if (cleanSpaceId) {
      const spaceScope = await this.accessService.resolveSpace(
        params.userId,
        cleanSpaceId,
      );
      return {
        spaceId: spaceScope.spaceId,
        pageId: undefined,
      };
    }

    return { spaceId: undefined, pageId: undefined };
  }

  async generate(params: AiGenerateParams): Promise<AiGenerateResult> {
    const messages: EngineMessage[] = [];
    if (params.systemInstruction) {
      messages.push({
        role: 'system',
        content: params.systemInstruction,
      });
    }
    messages.push({
      role: 'user',
      content: params.prompt,
    });

    const response = await this.engine.chatSync({
      messages,
      space_id: params.spaceId || params.userId || 'personal',
      page_id: params.pageId ?? null,
      stateless: true,
      intent_hint: 'direct',
      context:
        params.temperature !== undefined
          ? { temperature: params.temperature }
          : {},
    });

    return { text: response.content };
  }

  async health(): Promise<AiHealthStatus> {
    return this.engine.health();
  }
}
