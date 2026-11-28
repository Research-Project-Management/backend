import { EventEmitter } from 'node:events';
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { fromPartial } from '@total-typescript/shoehorn';
import type { FastifyReply } from 'fastify';
import {
  mapArtifactsToWidgets,
  mapCitationToSourceItem,
  normalizeRawCitations,
  SseFrameParser,
  translateEngineSseFrame,
} from '@/modules/ai/engine/domain/stream.mapper';
import { EngineService } from '@/modules/ai/engine/services/engine.service';
import { EngineHttpService } from '@/modules/ai/engine/services/http.service';
import { EngineStreamService } from '@/modules/ai/engine/services/stream.service';
import type { StreamCompletionResult } from '@/modules/ai/engine/types/engine.type';

function createMockRawResponse() {
  const emitter = new EventEmitter();
  const state = { writableEnded: false };
  const rawRes = Object.assign(emitter, {
    writeHead: jest.fn(),
    write: jest.fn(),
    get writableEnded() {
      return state.writableEnded;
    },
    end: jest.fn(() => {
      state.writableEnded = true;
    }),
    socket: { setNoDelay: jest.fn(), setTimeout: jest.fn() },
  });
  return rawRes;
}

describe('AI Engine Transport, SSE Mapper & Cancellation Suite', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('stream.mapper', () => {
    it('reconstructs split TCP chunks across UTF-8 Vietnamese boundaries and parses multi-event frames', () => {
      const parser = new SseFrameParser();
      const raw =
        'event: agent.routed\r\n' +
        'data: {"mode":"delegate","targets":["rag_agent","web_search_agent"]}\r\n\r\n' +
        'event: text.delta\r\n' +
        'data: {"delta":"Xin chào Tiếng Việt"}\r\n\r\n';

      const bytes = Buffer.from(raw, 'utf8');
      const splitPoint = bytes.indexOf('ế') + 1;
      const chunk1 = bytes.subarray(0, splitPoint);
      const chunk2 = bytes.subarray(splitPoint);

      const firstBatch = parser.feed(chunk1);
      const secondBatch = [...parser.feed(chunk2), ...parser.flush()];
      const allEvents = [...firstBatch, ...secondBatch];

      expect(allEvents).toHaveLength(2);
      expect(allEvents[0].event).toBe('agent.routed');
      expect(allEvents[1].event).toBe('text.delta');
      expect(JSON.parse(allEvents[1].data)).toEqual({
        delta: 'Xin chào Tiếng Việt',
      });
    });

    it('normalizes citations with positive integer index preservation and maps run.finished frames', () => {
      const normalized = normalizeRawCitations([
        {
          index: 6,
          source_id: 'doc-resnet',
          title: 'ResNet',
          page: 6,
          snippet: 'CIFAR-10 results',
        },
        { index: 0, source_id: 'doc-invalid-zero', title: 'Zero Index' },
        { index: 1.5, source_id: 'doc-float', title: 'Float Index' },
      ]);

      expect(normalized).toHaveLength(3);
      expect(normalized[0].index).toBe(6);
      expect(normalized[1].index).toBeUndefined();
      expect(normalized[2].index).toBeUndefined();

      const source = mapCitationToSourceItem({
        index: 6,
        source_id: 'fluxkv-2026',
        title: 'FluxKV Report',
        page: 2,
        url: null,
        snippet: null,
      });

      expect(source).toEqual({
        index: 6,
        source: 'fluxkv-2026 (p.2)',
        title: 'FluxKV Report',
        page: 2,
      });
      expect('url' in source).toBe(false);

      const translated = translateEngineSseFrame(
        'run.finished',
        JSON.stringify({
          route: 'rag_agent,web_search_agent',
          citations: [
            {
              source_id: 'arxiv:2205.14135',
              title: 'FlashAttention',
              url: 'https://arxiv.org/abs/2205.14135',
            },
          ],
        }),
      );

      expect(translated.finished).toBe(true);
      expect(translated.route).toBe('rag_agent,web_search_agent');
      expect(translated.citations).toHaveLength(1);
      expect(translated.clientFrames[0]).toContain('"type":"meta"');
      expect(translated.clientFrames[0]).toContain(
        'https://arxiv.org/abs/2205.14135',
      );
      expect(translated.clientFrames[1]).toBe('data: {"type":"done"}\n\n');
    });

    it('maps editor_patches, provenance, project widgets, patch_preview, and tool.completed error frames', () => {
      const widgets = mapArtifactsToWidgets({
        editor_patches: [
          {
            id: 'patch-1',
            file_id: 'doc-1',
            file_path: 'sections/intro.tex',
            kind: 'replace',
            title: 'Polish intro sentence',
            rationale: 'More concise academic phrasing',
            search_text: 'Old line',
            replace_text: 'New line',
            from_line: 10,
            to_line: 10,
            match_strategy: 'exact',
            warnings: ['Verify cite key'],
          },
        ],
        provenance: [
          {
            repo: 'flux-lab/vision-exp',
            path: 'eval/metrics.csv',
            commit_sha: 'a8f2c3e4b5d6e7f8a8f2c3e4b5d6e7f8a8f2c3e4',
            url: 'https://github.com/flux-lab/vision-exp/blob/a8f2c3e/eval/metrics.csv',
          },
          { repo: '', path: 'invalid.csv' },
        ],
        widgets: [
          {
            type: 'work_item_overview',
            title: 'Project Work Items Overview',
            total: 2,
            done: 1,
            inProgress: 1,
            overdue: 1,
            groups: [],
          },
        ],
      });

      expect(widgets).toHaveLength(2);
      expect(widgets[0]).toMatchObject({
        type: 'editor_patches',
        title: 'Proposed LaTeX Edit',
        provenance: [
          {
            repo: 'flux-lab/vision-exp',
            path: 'eval/metrics.csv',
            commitSha: 'a8f2c3e4b5d6e7f8a8f2c3e4b5d6e7f8a8f2c3e4',
            url: 'https://github.com/flux-lab/vision-exp/blob/a8f2c3e/eval/metrics.csv',
          },
        ],
        patches: [
          expect.objectContaining({
            id: 'patch-1',
            fileId: 'doc-1',
            filePath: 'sections/intro.tex',
            fromLine: 10,
            toLine: 10,
            matchStrategy: 'exact',
          }),
        ],
      });
      expect(widgets[1]).toMatchObject({
        type: 'work_item_overview',
        title: 'Project Work Items Overview',
      });

      const previewTranslated = translateEngineSseFrame(
        'editor.patch_preview',
        JSON.stringify({
          agent: 'editor_agent',
          total_patches: 2,
          patch: {
            id: 'patch-live-1',
            file_id: 'doc-method',
            file_path: 'sections/method.tex',
            kind: 'replace',
            title: 'Tighten method claim',
            search_text: 'We study FluxKV.',
            replace_text: 'We analyze FluxKV.',
            from_line: 5,
            to_line: 5,
            match_strategy: 'exact',
          },
        }),
      );
      expect(previewTranslated.clientFrames).toHaveLength(1);
      expect(
        JSON.parse(previewTranslated.clientFrames[0].replace(/^data: /, '').trim()),
      ).toMatchObject({
        type: 'editor-patch-preview',
        agent: 'editor_agent',
        totalPatches: 2,
      });

      const toolErr = translateEngineSseFrame(
        'tool.completed',
        JSON.stringify({
          tool: 'propose_edit',
          agent: 'editor_agent',
          status: 'error',
        }),
      );
      expect(toolErr.clientFrames[0]).toContain('"status":"error"');
      expect(toolErr.clientFrames[0]).toContain('"success":false');
    });
  });

  describe('EngineHttpService', () => {
    const createConfig = () =>
      fromPartial<ConfigService>({
        get: jest.fn((key: string) => {
          if (key === 'FLUX_AI_URL') return 'http://127.0.0.1:18420';
          if (key === 'AI_INTERNAL_API_KEY') return 'secret-internal-key';
          return undefined;
        }),
      });

    it('injects X-Internal-Key and X-Trace-Id and keeps circuit breaker closed across 4xx errors', async () => {
      const http = new EngineHttpService(createConfig());
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ detail: 'Bad query' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      for (let i = 0; i < 4; i++) {
        await expect(
          http.requestJson('/chat/sync', {
            method: 'POST',
            body: { messages: [] },
            traceId: 'trace-123',
          }),
        ).rejects.toThrow(BadRequestException);
      }

      expect(fetchSpy).toHaveBeenCalledTimes(4);
      const [, init] = fetchSpy.mock.calls[0];
      expect(init?.headers).toEqual(
        expect.objectContaining({
          'X-Internal-Key': 'secret-internal-key',
          'X-Trace-Id': 'trace-123',
        }),
      );
    });

    it('opens circuit breaker after consecutive 5xx upstream failures', async () => {
      const http = new EngineHttpService(createConfig());
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ detail: 'Upstream crash' }), {
          status: 503,
        }),
      );

      for (let i = 0; i < 3; i++) {
        await expect(
          http.requestJson('/chat/sync', { method: 'POST', body: {} }),
        ).rejects.toThrow(ServiceUnavailableException);
      }

      await expect(
        http.requestJson('/chat/sync', { method: 'POST', body: {} }),
      ).rejects.toThrow(/circuit breaker is open/i);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('injects Authorization Bearer delegation token and strips delegation_token and trace_id from JSON body', async () => {
      const http = new EngineHttpService(createConfig());
      const streamService = new EngineStreamService(http);
      const engine = new EngineService(http, streamService);

      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            content: 'Workspace tasks listed.',
            route: 'project_agent',
            status: 'completed',
            citations: [],
            interrupts: [],
            usage: {},
            trace_id: 'trace-deleg',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      await engine.chatSync({
        messages: [{ role: 'user', content: 'List my tasks' }],
        space_id: 'sp-1',
        trace_id: 'trace-deleg',
        delegation_token: 'user-jwt-token',
      });

      const [, init] = fetchSpy.mock.calls[0];
      expect(init?.headers).toEqual(
        expect.objectContaining({
          Authorization: 'Bearer user-jwt-token',
          'X-Internal-Key': 'secret-internal-key',
          'X-Trace-Id': 'trace-deleg',
        }),
      );

      const rawBody = typeof init?.body === 'string' ? init.body : '{}';
      const sentBody = JSON.parse(rawBody) as Record<string, unknown>;
      expect('delegation_token' in sentBody).toBe(false);
      expect('trace_id' in sentBody).toBe(false);
    });
  });

  describe('EngineStreamService & Cooperative Cancellation', () => {
    it('pipes SSE chunks, harvests citations on run.finished, and fires cancelThread on mid-stream close', async () => {
      const mockConfig = fromPartial<ConfigService>({
        get: jest.fn((key: string) =>
          key === 'FLUX_AI_URL' ? 'http://127.0.0.1:18420' : 'key-1',
        ),
      });

      const http = new EngineHttpService(mockConfig);
      const streamService = new EngineStreamService(http);
      const engine = new EngineService(http, streamService);

      const sseBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            Buffer.from(
              'event: text.delta\ndata: {"delta":"Hello "}\n\n' +
                'event: text.delta\ndata: {"delta":"World"}\n\n' +
                'event: run.finished\ndata: {"route":"rag_agent","citations":[{"source_id":"doc-1","title":"Paper","page":3}]}\n\n',
              'utf8',
            ),
          );
          controller.close();
        },
      });

      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(sseBody, { status: 200 }));

      const rawRes = createMockRawResponse();
      const reply = fromPartial<FastifyReply>({
        hijack: jest.fn(),
        getHeaders: jest.fn(() => ({})),
        request: { headers: {} },
        raw: fromPartial<FastifyReply['raw']>(rawRes),
      });

      let completedResult: StreamCompletionResult | undefined;
      await engine.chatStream(
        {
          messages: [{ role: 'user', content: 'Hi' }],
          space_id: 'sp-1',
          chat_id: 'chat-1',
        },
        reply,
        {
          initialFrames: ['data: {"type":"meta","chatId":"chat-1"}\n\n'],
          onComplete: (res) => {
            completedResult = res;
          },
        },
      );

      expect(completedResult).toBeDefined();
      expect(completedResult?.content).toBe('Hello World');
      expect(completedResult?.route).toBe('rag_agent');
      expect(completedResult?.sources).toEqual([
        { source: 'doc-1 (p.3)', title: 'Paper', page: 3 },
      ]);
      expect(completedResult?.cancelled).toBe(false);

      const hangingStream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(
            Buffer.from('event: text.delta\ndata: {"delta":"Partial"}\n\n'),
          );
        },
      });

      const cancelSpy = jest
        .spyOn(engine, 'cancelThread')
        .mockResolvedValue(undefined);
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(hangingStream, { status: 200 }));

      const cancelRes = createMockRawResponse();
      const cancelReply = fromPartial<FastifyReply>({
        hijack: jest.fn(),
        getHeaders: jest.fn(() => ({})),
        request: { headers: {} },
        raw: fromPartial<FastifyReply['raw']>(cancelRes),
      });

      const streamPromise = engine.chatStream(
        {
          messages: [{ role: 'user', content: 'Long run' }],
          space_id: 'sp-1',
          chat_id: 'chat-cancel-1',
        },
        cancelReply,
      );

      await new Promise((r) => setTimeout(r, 20));
      cancelRes.emit('close');
      await streamPromise;

      expect(cancelSpy).toHaveBeenCalledWith('sp-1', 'chat-cancel-1');
    });
  });
});
