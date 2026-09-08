import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { FastifyReply } from 'fastify';
import { Readable } from 'stream';
import { StreamChatPayload, SyncChatResponse } from './types/engine.types';
import { getErrorMessage, tryCatch } from '@/core/utils/error.util';

@Injectable()
export class EngineService {
  private readonly fluxUrl: string;
  private readonly logger = new Logger(EngineService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {
    this.fluxUrl =
      this.configService.get<string>('FLUX_AI_URL') || 'http://localhost:8000';
  }

  private async createDelegationToken(
    userId: string,
    workspaceId?: string,
    projectId?: string,
  ): Promise<string> {
    const secret =
      this.configService.get<string>('JWT_SECRET') || process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('JWT_SECRET is not configured');
    }
    return this.jwtService.signAsync(
      {
        sub: userId,
        workspace_id: workspaceId || undefined,
        project_id: projectId || undefined,
        scope: 'ai-delegated-action',
      },
      {
        secret,
        expiresIn: '10m',
      },
    );
  }

  private getInternalHeaders(delegationToken?: string): Record<string, string> {
    const internalKey =
      this.configService.get<string>('INTERNAL_API_KEY') ||
      process.env.INTERNAL_API_KEY ||
      '';
    const headers: Record<string, string> = {};
    if (internalKey) {
      headers['X-Internal-Key'] = internalKey;
    }
    if (delegationToken) {
      headers['Authorization'] = `Bearer ${delegationToken}`;
    }
    return headers;
  }

  async health(): Promise<{ status: string; [key: string]: unknown }> {
    const result = await tryCatch(
      fetch(`${this.fluxUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      }),
    );

    if (result.ok && result.value.ok) {
      const jsonResult = await tryCatch(result.value.json());
      return {
        status: 'ok',
        service: 'flux-ai-engine',
        upstream: jsonResult.ok ? jsonResult.value : 'healthy',
        timestamp: new Date().toISOString(),
      };
    }

    return {
      status: 'degraded',
      service: 'flux-ai-engine',
      upstream: 'unreachable',
      error: !result.ok
        ? getErrorMessage(result.error)
        : `Upstream HTTP ${result.value.status}`,
      timestamp: new Date().toISOString(),
    };
  }

  async streamChat(
    payload: StreamChatPayload,
    reply: FastifyReply,
  ): Promise<void> {
    reply.hijack();
    const rawRes = reply.raw;

    rawRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Transfer-Encoding': 'chunked',
    });

    if (rawRes.socket) {
      rawRes.socket.setNoDelay(true);
      rawRes.socket.setTimeout(0);
    }

    let delegationToken = '';
    try {
      delegationToken = await this.createDelegationToken(
        payload.user_id || '00000000-0000-0000-0000-000000000000',
        payload.workspace_id,
        payload.project_id,
      );
    } catch (tokenErr) {
      this.logger.error(
        'Failed to create delegation token for streamChat',
        tokenErr,
      );
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...this.getInternalHeaders(delegationToken),
    };

    const result = await tryCatch(
      fetch(`${this.fluxUrl}/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      }),
    );

    if (!result.ok || !result.value.ok) {
      const errMsg = result.ok
        ? `AI Engine error: status ${result.value.status}`
        : getErrorMessage(result.error);
      this.logger.warn(`AI Engine streaming fallback: ${errMsg}`);

      const fallbackMsg =
        'AI Assistant service is currently offline. Please ensure the Flux-AI backend service is running on ' +
        this.fluxUrl;
      rawRes.write(`data: ${fallbackMsg}\n\n`);
      rawRes.write('data: [DONE]\n\n');
      rawRes.end();
      return;
    }

    const responseBody = result.value.body;
    if (!responseBody) {
      rawRes.write('data: [DONE]\n\n');
      rawRes.end();
      return;
    }

    const nodeStream = Readable.fromWeb(responseBody as any);
    nodeStream.on('data', (chunk) => rawRes.write(chunk));
    nodeStream.on('end', () => rawRes.end());
    nodeStream.on('error', (err) => {
      this.logger.error('Stream pipe error:', err);
      rawRes.end();
    });

    rawRes.on('close', () => {
      nodeStream.destroy();
    });
  }

  async syncChat(payload: StreamChatPayload): Promise<SyncChatResponse> {
    let delegationToken = '';
    try {
      delegationToken = await this.createDelegationToken(
        payload.user_id || '00000000-0000-0000-0000-000000000000',
        payload.workspace_id,
        payload.project_id,
      );
    } catch (tokenErr) {
      this.logger.error(
        'Failed to create delegation token for syncChat',
        tokenErr,
      );
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.getInternalHeaders(delegationToken),
    };

    const result = await tryCatch(
      fetch(`${this.fluxUrl}/chat/sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      }),
    );

    if (result.ok && result.value.ok) {
      const jsonResult = await tryCatch(result.value.json());
      if (jsonResult.ok) {
        const val = jsonResult.value;
        if (val?.output?.content !== undefined) {
          return {
            role: 'assistant',
            content: val.output.content,
            sources: val.output.sources || [],
            widgets: val.output.widgets || [],
            intent: val.intent,
            ...val,
          };
        }
        return val as SyncChatResponse;
      }
    }

    return {
      role: 'assistant',
      content:
        'AI Assistant service is currently offline. Please ensure the Flux-AI backend service is running on ' +
        this.fluxUrl,
      sources: [],
      widgets: [],
    };
  }

  async uploadDocument(
    rawBody: Buffer,
    contentType: string,
    filename: string,
    context: {
      userId: string;
      workspaceId: string;
      projectId?: string;
      chatId?: string;
      title?: string;
      tags?: string;
    },
  ): Promise<Record<string, unknown>> {
    const delegationToken = await this.createDelegationToken(
      context.userId,
      context.workspaceId,
      context.projectId,
    );
    const headers = this.getInternalHeaders(delegationToken);

    const formData = new FormData();
    const blob = new Blob([new Uint8Array(rawBody)], { type: contentType });
    formData.append('file', blob, filename);
    formData.append('workspace_id', context.workspaceId);
    if (context.userId) formData.append('user_id', context.userId);
    if (context.projectId) formData.append('project_id', context.projectId);
    if (context.chatId) formData.append('chat_id', context.chatId);
    if (context.title) formData.append('title', context.title);
    if (context.tags) formData.append('tags', context.tags);

    const result = await tryCatch(
      fetch(`${this.fluxUrl}/documents/upload`, {
        method: 'POST',
        headers,
        body: formData,
      }),
    );

    if (result.ok && result.value.ok) {
      const json = await tryCatch(result.value.json());
      if (json.ok) return json.value as Record<string, unknown>;
    }

    const errDetail = result.ok
      ? `HTTP ${result.value.status}: ${await result.value.text().catch(() => '')}`
      : getErrorMessage(result.error);
    throw new Error(`Failed to upload document to AI engine: ${errDetail}`);
  }

  async getDocumentsBulk(
    ids: string[],
    context?: { userId: string; workspaceId: string; projectId?: string },
  ): Promise<Array<Record<string, unknown>>> {
    let headers: Record<string, string> = {};
    let wsQuery = '';
    if (context) {
      const delegationToken = await this.createDelegationToken(
        context.userId,
        context.workspaceId,
        context.projectId,
      );
      headers = this.getInternalHeaders(delegationToken);
      wsQuery = `&workspace_id=${encodeURIComponent(context.workspaceId)}`;
    }
    const result = await tryCatch(
      fetch(
        `${this.fluxUrl}/documents/bulk?ids=${encodeURIComponent(ids.join(','))}${wsQuery}`,
        { headers },
      ),
    );

    if (result.ok && result.value.ok) {
      const json = await tryCatch(result.value.json());
      if (json.ok) {
        const val = json.value as {
          documents?: Array<Record<string, unknown>>;
        };
        return (
          val.documents || (json.value as Array<Record<string, unknown>>) || []
        );
      }
    }

    return [];
  }

  async getDocument(
    docId: string,
    context?: { userId: string; workspaceId: string; projectId?: string },
  ): Promise<Record<string, unknown> | null> {
    let headers: Record<string, string> = {};
    let wsQuery = '';
    if (context) {
      const delegationToken = await this.createDelegationToken(
        context.userId,
        context.workspaceId,
        context.projectId,
      );
      headers = this.getInternalHeaders(delegationToken);
      wsQuery = `?workspace_id=${encodeURIComponent(context.workspaceId)}`;
    }
    const result = await tryCatch(
      fetch(
        `${this.fluxUrl}/documents/${encodeURIComponent(docId)}${wsQuery}`,
        {
          headers,
        },
      ),
    );

    if (result.ok && result.value.ok) {
      const json = await tryCatch(result.value.json());
      if (json.ok) return json.value as Record<string, unknown>;
    }

    return null;
  }

  async getDocuments(context?: {
    userId: string;
    workspaceId: string;
    projectId?: string;
  }): Promise<Array<Record<string, unknown>>> {
    let headers: Record<string, string> = {};
    let wsQuery = '';
    if (context) {
      const delegationToken = await this.createDelegationToken(
        context.userId,
        context.workspaceId,
        context.projectId,
      );
      headers = this.getInternalHeaders(delegationToken);
      wsQuery = `?workspace_id=${encodeURIComponent(context.workspaceId)}`;
    }
    const result = await tryCatch(
      fetch(`${this.fluxUrl}/documents/${wsQuery}`, { headers }),
    );

    if (result.ok && result.value.ok) {
      const json = await tryCatch(result.value.json());
      if (json.ok) return json.value as Array<Record<string, unknown>>;
    }

    return [];
  }
}
