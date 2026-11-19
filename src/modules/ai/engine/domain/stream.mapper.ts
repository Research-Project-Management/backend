import {
  EngineCitation,
  FrontendSourceItem,
  TranslatedSseFrame,
} from '../types/engine.type';

export interface RawSseEvent {
  event: string;
  data: string;
}

export function mapCitationToSourceItem(
  cite: EngineCitation,
): FrontendSourceItem {
  const sourceLabel =
    typeof cite.page === 'number'
      ? `${cite.source_id} (p.${cite.page})`
      : cite.source_id;

  const item: FrontendSourceItem = {
    source: sourceLabel,
  };
  if (typeof cite.title === 'string' && cite.title.trim()) {
    item.title = cite.title;
  }
  if (typeof cite.snippet === 'string' && cite.snippet.trim()) {
    item.snippet = cite.snippet;
  }
  if (typeof cite.url === 'string' && cite.url.trim()) {
    item.url = cite.url;
  }
  if (typeof cite.page === 'number') {
    item.page = cite.page;
  }
  return item;
}

export function normalizeRawCitations(raw: unknown): EngineCitation[] {
  if (!Array.isArray(raw)) return [];
  const citations: EngineCitation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const sourceId =
      typeof record.source_id === 'string' && record.source_id.trim()
        ? record.source_id
        : typeof record.source === 'string'
          ? record.source
          : '';
    if (!sourceId) continue;

    citations.push({
      source_id: sourceId,
      source_type:
        typeof record.source_type === 'string' ? record.source_type : undefined,
      title: typeof record.title === 'string' ? record.title : undefined,
      url: typeof record.url === 'string' ? record.url : undefined,
      page: typeof record.page === 'number' ? record.page : undefined,
      snippet: typeof record.snippet === 'string' ? record.snippet : undefined,
    });
  }
  return citations;
}

export class SseFrameParser {
  private readonly decoder = new TextDecoder('utf-8');
  private buffer = '';

  feed(chunk: Buffer | Uint8Array): RawSseEvent[] {
    const text = this.decoder.decode(chunk, { stream: true });
    return this.extractFrames(text);
  }

  flush(): RawSseEvent[] {
    const remaining = this.decoder.decode();
    return this.extractFrames(remaining, true);
  }

  private extractFrames(input: string, forceFlush = false): RawSseEvent[] {
    const normalized = input.replace(/\r\n/g, '\n');
    this.buffer += normalized;

    const blocks = this.buffer.split('\n\n');
    if (forceFlush) {
      this.buffer = '';
    } else {
      this.buffer = blocks.pop() ?? '';
    }

    const events: RawSseEvent[] = [];
    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      let eventName = 'message';
      const dataLines: string[] = [];
      for (const line of trimmed.split('\n')) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim() || 'message';
        } else if (line.startsWith('data:')) {
          const val = line.slice(5);
          dataLines.push(val.startsWith(' ') ? val.slice(1) : val);
        }
      }

      if (dataLines.length > 0) {
        events.push({
          event: eventName,
          data: dataLines.join('\n'),
        });
      }
    }

    return events;
  }
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Non-JSON payload handled below
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function translateEngineSseFrame(
  eventName: string,
  rawData: string,
): TranslatedSseFrame {
  if (rawData === '[DONE]') {
    return { clientFrames: ['data: [DONE]\n\n'], finished: true };
  }

  const payload = parseJsonObject(rawData);

  switch (eventName) {
    case 'run.started':
      return { clientFrames: [] };

    case 'agent.routed': {
      const targets = asStringArray(payload?.targets);
      const mode = typeof payload?.mode === 'string' ? payload.mode : 'direct';
      const routeLabel = targets.join(',');
      const frames = [
        `data: [META]${JSON.stringify({ agent: routeLabel || mode, intent: mode })}\n\n`,
      ];
      if (targets.length > 0) {
        frames.push(
          `data: [ACTION]${JSON.stringify({
            type: 'agent_handoff',
            to: routeLabel,
            parallel: targets.length > 1,
            status: 'calling',
          })}\n\n`,
        );
      }
      return { clientFrames: frames, route: routeLabel || mode };
    }

    case 'agent.started': {
      const agent =
        typeof payload?.agent === 'string' ? payload.agent : undefined;
      return {
        clientFrames: [
          `data: [ACTION]${JSON.stringify({
            type: 'thinking',
            agent,
            status: 'calling',
          })}\n\n`,
        ],
      };
    }

    case 'agent.finished': {
      const agent =
        typeof payload?.agent === 'string' ? payload.agent : undefined;
      return {
        clientFrames: [
          `data: [ACTION]${JSON.stringify({
            type: 'agent_done',
            agent,
            status: 'done',
            success: true,
          })}\n\n`,
        ],
      };
    }

    case 'tool.called': {
      const tool = typeof payload?.tool === 'string' ? payload.tool : undefined;
      const agent =
        typeof payload?.agent === 'string' ? payload.agent : undefined;
      return {
        clientFrames: [
          `data: [ACTION]${JSON.stringify({
            type: 'tool_start',
            tool,
            agent,
            status: 'calling',
          })}\n\n`,
        ],
      };
    }

    case 'tool.completed': {
      const tool = typeof payload?.tool === 'string' ? payload.tool : undefined;
      const agent =
        typeof payload?.agent === 'string' ? payload.agent : undefined;
      return {
        clientFrames: [
          `data: [ACTION]${JSON.stringify({
            type: 'tool_end',
            tool,
            agent,
            status: 'done',
            success: true,
          })}\n\n`,
        ],
      };
    }

    case 'text.delta': {
      const delta = typeof payload?.delta === 'string' ? payload.delta : '';
      if (!delta) return { clientFrames: [] };
      return {
        clientFrames: [`data: ${JSON.stringify({ delta })}\n\n`],
        deltaText: delta,
      };
    }

    case 'hitl.interrupted': {
      const interrupts = Array.isArray(payload?.interrupts)
        ? payload.interrupts
        : [];
      return {
        clientFrames: [
          `data: [ACTION]${JSON.stringify({
            type: 'tool_call',
            needs_confirm: true,
            input: { interrupts },
          })}\n\n`,
          'data: [DONE]\n\n',
        ],
        interrupts,
        finished: true,
      };
    }

    case 'run.finished': {
      const route =
        typeof payload?.route === 'string' ? payload.route : 'direct';
      const citations = normalizeRawCitations(payload?.citations);
      const sources = citations.map(mapCitationToSourceItem);
      return {
        clientFrames: [
          `data: [META]${JSON.stringify({ agent: route, sources })}\n\n`,
          'data: [DONE]\n\n',
        ],
        route,
        citations,
        finished: true,
      };
    }

    case 'run.cancelled':
      return {
        clientFrames: ['data: [DONE]\n\n'],
        cancelled: true,
        finished: true,
      };

    case 'run.error': {
      const errorMessage =
        typeof payload?.message === 'string'
          ? payload.message
          : typeof payload?.error === 'string'
            ? payload.error
            : 'AI runtime stream error';
      return {
        clientFrames: [
          `data: [ACTION]${JSON.stringify({
            type: 'agent_done',
            status: 'error',
            error: errorMessage,
            success: false,
          })}\n\n`,
          `event: error\ndata: ${JSON.stringify({ error: errorMessage })}\n\n`,
          'data: [DONE]\n\n',
        ],
        errorMessage,
        finished: true,
      };
    }

    default: {
      if (payload && typeof payload.delta === 'string') {
        return {
          clientFrames: [
            `data: ${JSON.stringify({ delta: payload.delta })}\n\n`,
          ],
          deltaText: payload.delta,
        };
      }
      return { clientFrames: [] };
    }
  }
}
