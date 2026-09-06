import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyReply } from 'fastify';
import { Readable } from 'stream';
import { StreamChatPayload, SyncChatResponse } from './types/engine.types';
import { getErrorMessage, tryCatch } from '@/core/utils/error.util';

@Injectable()
export class EngineService {
  private readonly fluxUrl: string;
  private readonly logger = new Logger(EngineService.name);

  constructor(private readonly configService: ConfigService) {
    this.fluxUrl =
      this.configService.get<string>('FLUX_AI_URL') || 'http://localhost:8000';
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

    const result = await tryCatch(
      fetch(`${this.fluxUrl}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
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
    const result = await tryCatch(
      fetch(`${this.fluxUrl}/chat/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );

    if (result.ok && result.value.ok) {
      const jsonResult = await tryCatch(result.value.json());
      if (jsonResult.ok) {
        const val = jsonResult.value as any;
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
  ): Promise<Record<string, unknown>> {
    const result = await tryCatch(
      fetch(`${this.fluxUrl}/documents/upload`, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: new Uint8Array(rawBody),
      }),
    );

    if (result.ok && result.value.ok) {
      const json = await tryCatch(result.value.json());
      if (json.ok) return json.value as Record<string, unknown>;
    }

    throw new Error('Failed to upload document to AI engine');
  }

  async getDocumentsBulk(
    ids: string[],
  ): Promise<Array<Record<string, unknown>>> {
    const result = await tryCatch(
      fetch(
        `${this.fluxUrl}/documents/bulk?ids=${encodeURIComponent(ids.join(','))}`,
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

  async getDocument(docId: string): Promise<Record<string, unknown> | null> {
    const result = await tryCatch(
      fetch(`${this.fluxUrl}/documents/${encodeURIComponent(docId)}`),
    );

    if (result.ok && result.value.ok) {
      const json = await tryCatch(result.value.json());
      if (json.ok) return json.value as Record<string, unknown>;
    }

    return null;
  }

  async getDocuments(): Promise<Array<Record<string, unknown>>> {
    const result = await tryCatch(fetch(`${this.fluxUrl}/documents/`));

    if (result.ok && result.value.ok) {
      const json = await tryCatch(result.value.json());
      if (json.ok) return json.value as Array<Record<string, unknown>>;
    }

    return [];
  }
}
