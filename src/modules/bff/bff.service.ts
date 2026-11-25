/**
 * modules/bff/bff.service.ts
 * Thin Web BFF orchestrator: composes domain services in parallel with
 * Circuit Breaker, Timeout, Singleflight cache, and payload normalization.
 * Strictly 1-way dependency: BFF -> Domain Services (zero Prisma access).
 *
 * Note on freshness: `projects` and `work-item` mutations actively invalidate
 * BFF caches via EventEmitter2. Chat unread counters & channel lists expire
 * via short TTL (15-20s) since realtime badges are pushed over Socket.IO.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { CoreService } from '@/modules/project/core/core.service';
import type { EnrichedProject } from '@/modules/project/core/types/project.type';
import { OverviewService } from '@/modules/project/overview/overview.service';
import type { ProjectOverviewResponseDto } from '@/modules/project/overview/dto/project-overview-response.dto';
import { YourWorkService } from '@/modules/project/your-work/your-work.service';
import type { YourWorkSummaryDto } from '@/modules/project/your-work/dto/your-work.dto';
import { ChatService } from '@/modules/chat/services/chat.service';
import { ProjectChannelService } from '@/modules/chat/services/project-channel.service';
import { EditorBootstrapService } from '@/modules/pages/bootstrap/editor-bootstrap.service';
import type {
  BootstrapEditorParams,
  EditorBootstrapResponseDto,
} from '@/modules/pages/bootstrap/editor-bootstrap.types';
import {
  BFF_CACHE_KEYS,
  BFF_CACHE_TTL_SECONDS,
  BffCacheService,
} from './bff.cache';
import {
  BffSectionCircuitBreaker,
  DEFAULT_BFF_SECTION_TIMEOUT_MS,
  settleOptionalSection,
  summarizeSectionOutcomes,
} from './bff.resilience';

export interface BffResponseMeta {
  channel: 'web';
  partial: boolean;
  degradedSections: string[];
  timedOutSections: string[];
  circuitOpenSections: string[];
  cacheHit: boolean;
  generatedAt: string;
  durationMs: number;
}

export interface BffEnvelope<TData> {
  data: TData;
  meta: BffResponseMeta;
}

export interface WebWorkspaceShellData {
  projects: {
    items: EnrichedProject[];
    myProjectIds: string[];
    sharedProjectIds: string[];
    total: number;
  };
  yourWork: YourWorkSummaryDto | null;
  chat: {
    totalConversations: number;
    totalUnreadCount: number;
  };
}

export interface WebProjectChannelSummary {
  id: string;
  name: string | null;
  topic: string | null;
  isDefault: boolean;
  memberCount: number;
  unreadCount: number;
  isMuted: boolean;
  isPinned: boolean;
  updatedAt: string;
}

export interface WebProjectBootstrapData {
  overview: ProjectOverviewResponseDto;
  channels: WebProjectChannelSummary[];
}

interface ComputedScreen<TData> {
  data: TData;
  degradedSections: string[];
  timedOutSections: string[];
  circuitOpenSections: string[];
  partial: boolean;
  generatedAt: string;
}

const EMPTY_CHAT_SUMMARY = {
  totalConversations: 0,
  totalUnreadCount: 0,
};

@Injectable()
export class BffService {
  private readonly logger = new Logger(BffService.name);
  private readonly circuitBreaker: BffSectionCircuitBreaker;
  private readonly sectionTimeoutMs: number;

  constructor(
    private readonly projectCoreService: CoreService,
    private readonly overviewService: OverviewService,
    private readonly yourWorkService: YourWorkService,
    private readonly chatService: ChatService,
    private readonly projectChannelService: ProjectChannelService,
    private readonly bffCache: BffCacheService,
    private readonly editorBootstrapService: EditorBootstrapService,
    @Optional() circuitBreaker?: BffSectionCircuitBreaker,
    @Optional() sectionTimeoutMs?: number,
  ) {
    this.circuitBreaker = circuitBreaker ?? new BffSectionCircuitBreaker();
    this.sectionTimeoutMs =
      typeof sectionTimeoutMs === 'number'
        ? sectionTimeoutMs
        : DEFAULT_BFF_SECTION_TIMEOUT_MS;
  }

  private async executeScreen<TData>(
    cacheKey: string,
    ttlSeconds: number,
    bypassRead: boolean,
    loader: () => Promise<Omit<ComputedScreen<TData>, 'generatedAt'>>,
  ): Promise<BffEnvelope<TData>> {
    const startedAt = Date.now();

    const { value: computed, cacheHit } = await this.bffCache.getOrCompute<
      ComputedScreen<TData>
    >(cacheKey, { ttlSeconds, bypassRead }, async () => {
      const result = await loader();
      return {
        value: {
          ...result,
          generatedAt: new Date().toISOString(),
        },
        cacheable: !result.partial,
      };
    });

    return {
      data: computed.data,
      meta: {
        channel: 'web',
        partial: computed.partial,
        degradedSections: computed.degradedSections,
        timedOutSections: computed.timedOutSections,
        circuitOpenSections: computed.circuitOpenSections,
        cacheHit,
        generatedAt: computed.generatedAt,
        durationMs: Date.now() - startedAt,
      },
    };
  }

  getWorkspaceShell(
    userId: string,
    options?: { bypassCache?: boolean },
  ): Promise<BffEnvelope<WebWorkspaceShellData>> {
    return this.executeScreen<WebWorkspaceShellData>(
      BFF_CACHE_KEYS.workspaceShell(userId),
      BFF_CACHE_TTL_SECONDS.workspaceShell,
      Boolean(options?.bypassCache),
      async () => {
        const [projectsResult, yourWorkSection, chatSection] =
          await Promise.all([
            this.projectCoreService.findUserProjects(userId),
            settleOptionalSection(
              'yourWork',
              () => this.yourWorkService.getYourWork(undefined, userId),
              null,
              {
                timeoutMs: this.sectionTimeoutMs,
                logger: this.logger,
                circuitBreaker: this.circuitBreaker,
              },
            ),
            settleOptionalSection(
              'chat',
              async () => {
                const buckets =
                  await this.chatService.getUserConversations(userId);
                const all = [
                  ...buckets.directs,
                  ...buckets.groups,
                  ...buckets.projectChannels,
                ];
                let totalUnreadCount = 0;
                for (const conv of all) {
                  if (
                    typeof conv.unreadCount === 'number' &&
                    conv.unreadCount > 0
                  ) {
                    totalUnreadCount += conv.unreadCount;
                  }
                }
                return { totalConversations: all.length, totalUnreadCount };
              },
              EMPTY_CHAT_SUMMARY,
              {
                timeoutMs: this.sectionTimeoutMs,
                logger: this.logger,
                circuitBreaker: this.circuitBreaker,
              },
            ),
          ]);

        const summary = summarizeSectionOutcomes([
          yourWorkSection,
          chatSection,
        ]);

        return {
          data: {
            projects: {
              items: projectsResult.projects,
              myProjectIds: projectsResult.myProjects.map((p) => p.id),
              sharedProjectIds: projectsResult.sharedProjects.map((p) => p.id),
              total: projectsResult.total,
            },
            yourWork: yourWorkSection.value,
            chat: chatSection.value,
          },
          ...summary,
        };
      },
    );
  }

  getProjectBootstrap(
    projectId: string,
    userId: string,
    options?: { bypassCache?: boolean },
  ): Promise<BffEnvelope<WebProjectBootstrapData>> {
    return this.executeScreen<WebProjectBootstrapData>(
      BFF_CACHE_KEYS.projectBootstrap(projectId, userId),
      BFF_CACHE_TTL_SECONDS.projectBootstrap,
      Boolean(options?.bypassCache),
      async () => {
        const [overview, channelsSection] = await Promise.all([
          this.overviewService.getProjectOverview(projectId),
          settleOptionalSection<WebProjectChannelSummary[]>(
            'channels',
            async () => {
              const channels =
                await this.projectChannelService.getProjectChannels(
                  projectId,
                  userId,
                );
              return channels.map((ch) => ({
                id: ch.id,
                name: ch.name,
                topic: ch.topic,
                isDefault: ch.isDefault,
                memberCount: ch.memberCount,
                unreadCount: ch.unreadCount,
                isMuted: ch.isMuted,
                isPinned: ch.isPinned,
                updatedAt: ch.updatedAt,
              }));
            },
            [],
            {
              timeoutMs: this.sectionTimeoutMs,
              logger: this.logger,
              circuitBreaker: this.circuitBreaker,
            },
          ),
        ]);

        const summary = summarizeSectionOutcomes([channelsSection]);

        return {
          data: {
            overview,
            channels: channelsSection.value,
          },
          ...summary,
        };
      },
    );
  }

  async getEditorBootstrap(
    params: BootstrapEditorParams,
  ): Promise<BffEnvelope<EditorBootstrapResponseDto>> {
    const startedAt = Date.now();
    const result = await this.editorBootstrapService.bootstrapEditor(params);
    const degradedBranches = result.degradedBranches ?? [];

    return {
      data: result,
      meta: {
        channel: 'web',
        partial: result.degraded || degradedBranches.length > 0,
        degradedSections: [...degradedBranches],
        timedOutSections: [],
        circuitOpenSections: [],
        cacheHit: false,
        generatedAt: result.serverTimestamp || new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      },
    };
  }
}
