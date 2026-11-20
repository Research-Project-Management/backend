import { Injectable, Logger } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { getErrorMessage, isOriginAllowed } from '@/core';
import {
  mapCitationToSourceItem,
  SseFrameParser,
  translateEngineSseFrame,
} from '../domain/stream.mapper';
import {
  EngineCitation,
  FrontendResponseWidget,
  StreamCompletionResult,
  StreamOptions,
  TranslatedSseFrame,
} from '../types/engine.type';
import { EngineHttpService } from './http.service';

export interface PipeStreamParams {
  path: string;
  body: unknown;
  reply: FastifyReply;
  traceId?: string;
  delegationToken?: string;
  options?: StreamOptions;
  cancelContext?: {
    spaceId: string;
    chatId?: string | null;
    onCancel: (spaceId: string, chatId: string) => Promise<void>;
  };
}

@Injectable()
export class EngineStreamService {
  private readonly logger = new Logger(EngineStreamService.name);

  constructor(private readonly http: EngineHttpService) {}

  async pipeStream(params: PipeStreamParams): Promise<void> {
    const { reply, options, cancelContext } = params;
    reply.hijack();
    const rawRes = reply.raw;
    const originHeader = reply.request?.headers?.origin;
    const origin = typeof originHeader === 'string' ? originHeader : '';

    const sseHeaders = this.buildSseHeaders(reply, origin);
    rawRes.writeHead(200, sseHeaders);
    if (rawRes.socket) {
      rawRes.socket.setNoDelay(true);
      rawRes.socket.setTimeout(0);
    }

    if (options?.initialFrames) {
      for (const frame of options.initialFrames) {
        if (!rawRes.writableEnded) {
          rawRes.write(frame);
        }
      }
    }

    const abortController = new AbortController();
    let streamCompleted = false;
    let clientDisconnected = false;

    const triggerUpstreamCancel = () => {
      if (cancelContext?.chatId) {
        void cancelContext
          .onCancel(cancelContext.spaceId, cancelContext.chatId)
          .catch((err: unknown) => {
            this.logger.debug(
              `Non-fatal cancel notification failed: ${getErrorMessage(err)}`,
            );
          });
      }
    };

    rawRes.on('close', () => {
      if (!streamCompleted) {
        clientDisconnected = true;
        abortController.abort();
        triggerUpstreamCancel();
      }
    });

    let upstreamResponse: Response;
    try {
      upstreamResponse = await this.http.openStream(
        params.path,
        params.body,
        abortController.signal,
        params.traceId,
        params.delegationToken,
      );
    } catch (err: unknown) {
      if (!clientDisconnected && !rawRes.writableEnded) {
        const message = getErrorMessage(err);
        this.logger.warn(`SSE upstream connection error: ${message}`);
        rawRes.write(
          `event: error\ndata: ${JSON.stringify({ error: message })}\n\n`,
        );
        rawRes.write('data: [DONE]\n\n');
        rawRes.end();
      }
      return;
    }

    if (!upstreamResponse.body) {
      streamCompleted = true;
      await this.invokeOnComplete(options, {
        content: '',
        route: 'direct',
        citations: [],
        sources: [],
        artifacts: {},
        widgets: [],
        interrupts: [],
        cancelled: false,
      });
      if (!rawRes.writableEnded) {
        rawRes.write('data: [DONE]\n\n');
        rawRes.end();
      }
      return;
    }

    const parser = new SseFrameParser();
    let accumulatedText = '';
    let resolvedRoute = 'direct';
    let finalCitations: EngineCitation[] = [];
    let finalArtifacts: Record<string, unknown> = {};
    let finalWidgets: FrontendResponseWidget[] = [];
    let finalInterrupts: unknown[] = [];
    let sawTerminalFrame = false;
    let cancelled = false;
    let finalized = false;

    const applyTranslatedFrame = (translated: TranslatedSseFrame) => {
      if (translated.deltaText) {
        accumulatedText += translated.deltaText;
      }
      if (translated.route) {
        resolvedRoute = translated.route;
      }
      if (translated.citations) {
        finalCitations = translated.citations;
      }
      if (translated.artifacts) {
        finalArtifacts = translated.artifacts;
      }
      if (translated.widgets) {
        finalWidgets = translated.widgets;
      }
      if (translated.interrupts) {
        finalInterrupts = translated.interrupts;
      }
      if (translated.cancelled) {
        cancelled = true;
      }
      if (translated.finished) {
        sawTerminalFrame = true;
      }
      for (const frame of translated.clientFrames) {
        if (!rawRes.writableEnded) {
          rawRes.write(frame);
        }
      }
    };

    const nodeStream = Readable.fromWeb(
      upstreamResponse.body as unknown as NodeReadableStream,
    );

    await new Promise<void>((resolve) => {
      const finishStream = async () => {
        if (finalized) return;
        finalized = true;
        streamCompleted = true;

        for (const frame of parser.flush()) {
          applyTranslatedFrame(
            translateEngineSseFrame(frame.event, frame.data),
          );
        }

        if (!sawTerminalFrame && !clientDisconnected && !rawRes.writableEnded) {
          rawRes.write('data: [DONE]\n\n');
        }

        const sources = finalCitations.map(mapCitationToSourceItem);
        await this.invokeOnComplete(options, {
          content: accumulatedText,
          route: resolvedRoute,
          citations: finalCitations,
          sources,
          artifacts: finalArtifacts,
          widgets: finalWidgets,
          interrupts: finalInterrupts,
          cancelled: cancelled || clientDisconnected,
        });

        if (!rawRes.writableEnded) {
          rawRes.end();
        }
        resolve();
      };

      nodeStream.on('data', (chunk: Buffer | string) => {
        const buffer =
          typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        for (const frame of parser.feed(buffer)) {
          applyTranslatedFrame(
            translateEngineSseFrame(frame.event, frame.data),
          );
        }
      });

      nodeStream.on('end', () => {
        void finishStream();
      });

      nodeStream.on('close', () => {
        void finishStream();
      });

      nodeStream.on('error', (err: Error) => {
        if (!clientDisconnected) {
          this.logger.warn(`Upstream SSE read error: ${err.message}`);
          if (!rawRes.writableEnded) {
            rawRes.write(
              `event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`,
            );
          }
        }
        void finishStream();
      });

      rawRes.once('close', () => {
        if (!finalized) {
          nodeStream.destroy();
        }
      });
    });
  }

  private async invokeOnComplete(
    options: StreamOptions | undefined,
    result: StreamCompletionResult,
  ): Promise<void> {
    if (!options?.onComplete) return;
    try {
      await options.onComplete(result);
    } catch (err: unknown) {
      this.logger.warn(
        `Stream onComplete callback failed: ${getErrorMessage(err)}`,
      );
    }
  }

  private buildSseHeaders(
    reply: FastifyReply,
    origin: string,
  ): Record<string, string | string[]> {
    const existing = reply.getHeaders ? reply.getHeaders() : {};
    const headers: Record<string, string | string[]> = {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Transfer-Encoding': 'chunked',
    };

    for (const [key, value] of Object.entries(existing)) {
      if (typeof value === 'string' || Array.isArray(value)) {
        headers[key] = value;
      } else if (typeof value === 'number') {
        headers[key] = String(value);
      }
    }

    if (origin && isOriginAllowed(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Credentials'] = 'true';
      headers.Vary = 'Origin';
      headers['Access-Control-Expose-Headers'] =
        'Content-Type, Content-Length, X-Accel-Buffering';
    }

    return headers;
  }
}
