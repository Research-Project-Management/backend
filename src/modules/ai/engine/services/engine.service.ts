import { Injectable } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { getErrorMessage, tryCatch } from '@/core';
import type { AiHealthStatus } from '../../ai.type';
import {
  mapArtifactsToWidgets,
  mapCitationToSourceItem,
  normalizeRawCitations,
} from '../domain/stream.mapper';
import type { IAiEnginePort } from '../engine.port';
import type {
  EngineAgentInfo,
  EngineChatRequest,
  EngineChatResponse,
  EngineDeleteResponse,
  EngineIngestInput,
  EngineIngestResponse,
  EngineKnowledgeSearchHit,
  EngineKnowledgeSearchInput,
  EngineResumeRequest,
  StreamOptions,
} from '../types/engine.type';
import { EngineHttpService } from './http.service';
import { EngineStreamService } from './stream.service';

@Injectable()
export class EngineService implements IAiEnginePort {
  constructor(
    private readonly http: EngineHttpService,
    private readonly streamService: EngineStreamService,
  ) {}

  async health(): Promise<AiHealthStatus> {
    const res = await tryCatch(
      this.http.requestJson<Record<string, unknown>>('/health', {
        method: 'GET',
        timeoutMs: 5000,
        skipCircuitBreaker: true,
      }),
    );

    if (res.ok) {
      const upstreamStatus = res.value.status;
      return {
        status: upstreamStatus === 'ok' ? 'ok' : 'degraded',
        service: 'flux-ai',
        upstream: res.value,
        timestamp: new Date().toISOString(),
      };
    }

    return {
      status: 'degraded',
      service: 'flux-ai',
      upstream: 'unreachable',
      error: getErrorMessage(res.error),
      timestamp: new Date().toISOString(),
    };
  }

  async listAgents(): Promise<EngineAgentInfo[]> {
    const res = await this.http.requestJson<{ agents?: EngineAgentInfo[] }>(
      '/agents',
      { method: 'GET', timeoutMs: 10000 },
    );
    return Array.isArray(res.agents) ? res.agents : [];
  }

  async chatSync(request: EngineChatRequest): Promise<EngineChatResponse> {
    const { trace_id, delegation_token, ...payload } = request;
    const raw = await this.http.requestJson<Record<string, unknown>>(
      '/chat/sync',
      {
        method: 'POST',
        body: payload,
        timeoutMs: 120000,
        traceId: trace_id,
        delegationToken: delegation_token,
      },
    );
    return this.normalizeChatResponse(raw);
  }

  async chatStream(
    request: EngineChatRequest,
    reply: FastifyReply,
    options?: StreamOptions,
  ): Promise<void> {
    const { trace_id, delegation_token, ...payload } = request;
    await this.streamService.pipeStream({
      path: '/chat',
      body: payload,
      reply,
      traceId: trace_id,
      delegationToken: delegation_token,
      options,
      cancelContext: request.chat_id
        ? {
            spaceId: request.space_id,
            chatId: request.chat_id,
            onCancel: (spaceId, chatId) => this.cancelThread(spaceId, chatId),
          }
        : undefined,
    });
  }

  async resumeSync(request: EngineResumeRequest): Promise<EngineChatResponse> {
    const { trace_id, delegation_token, ...payload } = request;
    const raw = await this.http.requestJson<Record<string, unknown>>(
      '/chat/resume/sync',
      {
        method: 'POST',
        body: payload,
        timeoutMs: 120000,
        traceId: trace_id,
        delegationToken: delegation_token,
      },
    );
    return this.normalizeChatResponse(raw);
  }

  async resumeStream(
    request: EngineResumeRequest,
    reply: FastifyReply,
    options?: StreamOptions,
  ): Promise<void> {
    const { trace_id, delegation_token, ...payload } = request;
    await this.streamService.pipeStream({
      path: '/chat/resume',
      body: payload,
      reply,
      traceId: trace_id,
      delegationToken: delegation_token,
      options,
      cancelContext: {
        spaceId: request.space_id,
        chatId: request.chat_id,
        onCancel: (spaceId, chatId) => this.cancelThread(spaceId, chatId),
      },
    });
  }

  async cancelThread(spaceId: string, chatId: string): Promise<void> {
    const qs = new URLSearchParams({ space_id: spaceId }).toString();
    await this.http.requestJson<Record<string, unknown>>(
      `/threads/${encodeURIComponent(chatId)}/cancel?${qs}`,
      { method: 'POST', timeoutMs: 5000 },
    );
  }

  async deleteThread(
    spaceId: string,
    chatId: string,
  ): Promise<EngineDeleteResponse> {
    const qs = new URLSearchParams({ space_id: spaceId }).toString();
    return this.http.requestJson<EngineDeleteResponse>(
      `/threads/${encodeURIComponent(chatId)}?${qs}`,
      { method: 'DELETE', timeoutMs: 10000 },
    );
  }

  async deleteSpaceThreads(spaceId: string): Promise<EngineDeleteResponse> {
    return this.http.requestJson<EngineDeleteResponse>(
      `/spaces/${encodeURIComponent(spaceId)}/threads`,
      { method: 'DELETE', timeoutMs: 10000 },
    );
  }

  async ingestDocument(
    input: EngineIngestInput,
  ): Promise<EngineIngestResponse> {
    const formData = new FormData();
    const blob = new Blob([new Uint8Array(input.fileBuffer)], {
      type: input.mimeType || 'application/octet-stream',
    });
    formData.append('file', blob, input.filename);
    formData.append('space_id', input.spaceId);
    formData.append('source_type', input.sourceType);
    formData.append('source_id', input.sourceId);
    if (input.title) formData.append('title', input.title);
    if (input.url) formData.append('url', input.url);
    formData.append('metadata_json', JSON.stringify(input.metadata ?? {}));

    return this.http.requestJson<EngineIngestResponse>('/knowledge/ingest', {
      method: 'POST',
      body: formData,
      timeoutMs: 120000,
    });
  }

  async searchKnowledge(
    input: EngineKnowledgeSearchInput,
  ): Promise<EngineKnowledgeSearchHit[]> {
    const res = await this.http.requestJson<{
      hits?: EngineKnowledgeSearchHit[];
    }>('/knowledge/search', {
      method: 'POST',
      body: input,
      timeoutMs: 30000,
    });
    return Array.isArray(res.hits) ? res.hits : [];
  }

  async deleteKnowledgeSource(
    spaceId: string,
    sourceType: string,
    sourceId: string,
  ): Promise<EngineDeleteResponse> {
    const qs = new URLSearchParams({ space_id: spaceId }).toString();
    return this.http.requestJson<EngineDeleteResponse>(
      `/knowledge/${encodeURIComponent(sourceType)}/${encodeURIComponent(sourceId)}?${qs}`,
      { method: 'DELETE', timeoutMs: 15000 },
    );
  }

  async deleteSpaceKnowledge(spaceId: string): Promise<EngineDeleteResponse> {
    return this.http.requestJson<EngineDeleteResponse>(
      `/spaces/${encodeURIComponent(spaceId)}/knowledge`,
      { method: 'DELETE', timeoutMs: 15000 },
    );
  }

  private normalizeChatResponse(
    raw: Record<string, unknown>,
  ): EngineChatResponse {
    const citations = normalizeRawCitations(raw.citations);
    const sources = citations.map(mapCitationToSourceItem);
    const artifacts =
      raw.artifacts &&
      typeof raw.artifacts === 'object' &&
      !Array.isArray(raw.artifacts)
        ? (raw.artifacts as Record<string, unknown>)
        : undefined;
    const widgets = mapArtifactsToWidgets(artifacts);
    return {
      content: typeof raw.content === 'string' ? raw.content : '',
      route: typeof raw.route === 'string' ? raw.route : 'direct',
      status: raw.status === 'interrupted' ? 'interrupted' : 'completed',
      citations,
      sources,
      ...(artifacts ? { artifacts } : {}),
      ...(widgets.length > 0 ? { widgets } : {}),
      interrupts: Array.isArray(raw.interrupts) ? raw.interrupts : [],
      usage:
        raw.usage && typeof raw.usage === 'object'
          ? (raw.usage as Record<string, unknown>)
          : {},
      stateless: typeof raw.stateless === 'boolean' ? raw.stateless : undefined,
      trace_id: typeof raw.trace_id === 'string' ? raw.trace_id : '',
    };
  }
}
