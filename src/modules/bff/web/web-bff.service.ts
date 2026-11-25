/**
 * modules/bff/web/web-bff.service.ts
 * Subsystem 2 (Orchestration & Aggregation):
 * Thin Web-channel orchestrator composing domain services with per-section
 * timeouts, graceful degradation, pure shaping, and channel-scoped caching.
 *
 * Architectural constraints:
 * - Strictly 1-way dependency: BFF -> Domain Services only (zero Prisma access).
 * - Zero business rules or domain mutations.
 * - Degraded/partial payloads are never cached to avoid poisoning subsequent reads.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { CoreService } from '@/modules/project/core/core.service';
import { OverviewService } from '@/modules/project/overview/overview.service';
import { YourWorkService } from '@/modules/project/your-work/your-work.service';
import { ChatService } from '@/modules/chat/services/chat.service';
import { ProjectChannelService } from '@/modules/chat/services/project-channel.service';
import { EditorBootstrapService } from '@/modules/pages/bootstrap/editor-bootstrap.service';
import type { BootstrapEditorParams } from '@/modules/pages/bootstrap/editor-bootstrap.types';
import { BFF_CACHE_KEYS, BFF_CACHE_TTL_SECONDS } from '../core/bff-cache.keys';
import { BffCacheService } from '../core/bff-cache.service';
import {
  DEFAULT_BFF_SECTION_TIMEOUT_MS,
  settleOptionalSection,
  summarizeSectionOutcomes,
} from '../core/bff-resilience.util';
import type { BffEnvelope } from '../core/bff.types';
import {
  shapeWebProjectChannels,
  shapeWebWorkspaceChatSummary,
  shapeWebWorkspaceProjects,
} from './web-bff.shaper';
import type {
  WebEditorBootstrapData,
  WebProjectBootstrapData,
  WebWorkspaceChatSummary,
  WebWorkspaceShellData,
} from './web-bff.types';

const EMPTY_CHAT_SUMMARY: WebWorkspaceChatSummary = {
  totalConversations: 0,
  totalUnreadCount: 0,
};

interface ComputedScreen<TData> {
  data: TData;
  degradedSections: string[];
  timedOutSections: string[];
  partial: boolean;
}

@Injectable()
export class WebBffService {
  private readonly logger = new Logger(WebBffService.name);

  constructor(
    private readonly projectCoreService: CoreService,
    private readonly overviewService: OverviewService,
    private readonly yourWorkService: YourWorkService,
    private readonly chatService: ChatService,
    private readonly projectChannelService: ProjectChannelService,
    private readonly bffCache: BffCacheService,
    @Optional()
    private readonly editorBootstrapService?: EditorBootstrapService,
  ) {}

  /**
   * Hydrates the Web workspace shell (projects + yourWork + chat summary)
   * in a single HTTP round-trip with short-TTL channel caching.
   */
  async getWorkspaceShell(
    userId: string,
    options?: { bypassCache?: boolean; sectionTimeoutMs?: number },
  ): Promise<BffEnvelope<WebWorkspaceShellData>> {
    const startedAt = Date.now();
    const cacheKey = BFF_CACHE_KEYS.workspaceShell('web', userId);
    const ttl = options?.bypassCache ? 0 : BFF_CACHE_TTL_SECONDS.workspaceShell;
    const timeoutMs =
      options?.sectionTimeoutMs ?? DEFAULT_BFF_SECTION_TIMEOUT_MS;

    const { value: computed, cacheHit } = await this.bffCache.getOrCompute<
      ComputedScreen<WebWorkspaceShellData>
    >(cacheKey, ttl, async () => {
      const [projectsResult, yourWorkSection, chatSection] = await Promise.all([
        this.projectCoreService.findUserProjects(userId),
        settleOptionalSection(
          'yourWork',
          () => this.yourWorkService.getYourWork(undefined, userId),
          null,
          { timeoutMs, logger: this.logger },
        ),
        settleOptionalSection(
          'chat',
          async () =>
            shapeWebWorkspaceChatSummary(
              await this.chatService.getUserConversations(userId),
            ),
          EMPTY_CHAT_SUMMARY,
          { timeoutMs, logger: this.logger },
        ),
      ]);

      const summary = summarizeSectionOutcomes([yourWorkSection, chatSection]);

      const payload: ComputedScreen<WebWorkspaceShellData> = {
        data: {
          projects: shapeWebWorkspaceProjects(projectsResult),
          yourWork: yourWorkSection.value,
          chat: chatSection.value,
        },
        ...summary,
      };

      return { value: payload, cacheable: !summary.partial };
    });

    return {
      data: computed.data,
      meta: {
        channel: 'web',
        partial: computed.partial,
        degradedSections: computed.degradedSections,
        timedOutSections: computed.timedOutSections,
        cacheHit,
        generatedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      },
    };
  }

  /**
   * Hydrates a Web Project screen (overview dashboard + shaped chat channels)
   * in a single HTTP round-trip with short-TTL channel caching.
   */
  async getProjectBootstrap(
    projectId: string,
    userId: string,
    options?: { bypassCache?: boolean; sectionTimeoutMs?: number },
  ): Promise<BffEnvelope<WebProjectBootstrapData>> {
    const startedAt = Date.now();
    const cacheKey = BFF_CACHE_KEYS.projectBootstrap('web', projectId, userId);
    const ttl = options?.bypassCache
      ? 0
      : BFF_CACHE_TTL_SECONDS.projectBootstrap;
    const timeoutMs =
      options?.sectionTimeoutMs ?? DEFAULT_BFF_SECTION_TIMEOUT_MS;

    const { value: computed, cacheHit } = await this.bffCache.getOrCompute<
      ComputedScreen<WebProjectBootstrapData>
    >(cacheKey, ttl, async () => {
      const [overview, channelsSection] = await Promise.all([
        this.overviewService.getProjectOverview(projectId),
        settleOptionalSection(
          'channels',
          async () =>
            shapeWebProjectChannels(
              await this.projectChannelService.getProjectChannels(
                projectId,
                userId,
              ),
            ),
          [],
          { timeoutMs, logger: this.logger },
        ),
      ]);

      const summary = summarizeSectionOutcomes([channelsSection]);

      const payload: ComputedScreen<WebProjectBootstrapData> = {
        data: {
          overview,
          channels: channelsSection.value,
        },
        ...summary,
      };

      return { value: payload, cacheable: !summary.partial };
    });

    return {
      data: computed.data,
      meta: {
        channel: 'web',
        partial: computed.partial,
        degradedSections: computed.degradedSections,
        timedOutSections: computed.timedOutSections,
        cacheHit,
        generatedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      },
    };
  }

  /**
   * Exposes the unified Pages Editor Bootstrap under the standardized Web BFF
   * envelope without breaking the existing /api/v1/pages/:id/bootstrap route.
   */
  async getEditorBootstrap(
    params: BootstrapEditorParams,
  ): Promise<BffEnvelope<WebEditorBootstrapData>> {
    const startedAt = Date.now();

    if (!this.editorBootstrapService) {
      throw new Error(
        'EditorBootstrapService is not registered in WebBffModule',
      );
    }

    const result = await this.editorBootstrapService.bootstrapEditor(params);
    const degradedBranches = result.degradedBranches ?? [];

    return {
      data: result,
      meta: {
        channel: 'web',
        partial: result.degraded || degradedBranches.length > 0,
        degradedSections: [...degradedBranches],
        timedOutSections: [],
        cacheHit: false,
        generatedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      },
    };
  }
}
