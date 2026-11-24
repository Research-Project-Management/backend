import {
  EngineCitation,
  FluxClientSseEvent,
  FrontendEditorPatchItem,
  FrontendHitlInterrupt,
  FrontendProvenanceItem,
  FrontendResponseWidget,
  FrontendSourceItem,
  TranslatedSseFrame,
} from '../types/engine.type';

interface RawSseEvent {
  event: string;
  data: string;
}

export function encodeSseEvent(event: FluxClientSseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
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
  if (
    typeof cite.index === 'number' &&
    Number.isInteger(cite.index) &&
    cite.index > 0
  ) {
    item.index = cite.index;
  }
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
      index:
        typeof record.index === 'number' &&
        Number.isInteger(record.index) &&
        record.index > 0
          ? record.index
          : undefined,
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

function normalizeEditorPatch(
  raw: unknown,
  idx: number,
): FrontendEditorPatchItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const filePath =
    typeof rec.file_path === 'string' && rec.file_path.trim()
      ? rec.file_path.trim()
      : typeof rec.filePath === 'string' && rec.filePath.trim()
        ? rec.filePath.trim()
        : '';
  const searchText =
    typeof rec.search_text === 'string'
      ? rec.search_text
      : typeof rec.searchText === 'string'
        ? rec.searchText
        : '';
  const replaceText =
    typeof rec.replace_text === 'string'
      ? rec.replace_text
      : typeof rec.replaceText === 'string'
        ? rec.replaceText
        : '';
  if (!filePath) return null;

  const warnings = Array.isArray(rec.warnings)
    ? rec.warnings.filter(
        (w): w is string => typeof w === 'string' && w.trim().length > 0,
      )
    : undefined;

  return {
    id:
      typeof rec.id === 'string' && rec.id.trim() ? rec.id : `patch-${idx + 1}`,
    fileId:
      typeof rec.file_id === 'string' && rec.file_id.trim()
        ? rec.file_id
        : typeof rec.fileId === 'string' && rec.fileId.trim()
          ? rec.fileId
          : null,
    filePath,
    kind: typeof rec.kind === 'string' ? rec.kind : 'replace',
    title:
      typeof rec.title === 'string' && rec.title.trim()
        ? rec.title.trim()
        : 'LaTeX Edit',
    ...(typeof rec.rationale === 'string' && rec.rationale.trim()
      ? { rationale: rec.rationale.trim() }
      : {}),
    searchText,
    replaceText,
    ...(typeof rec.from_line === 'number'
      ? { fromLine: rec.from_line }
      : typeof rec.fromLine === 'number'
        ? { fromLine: rec.fromLine }
        : {}),
    ...(typeof rec.to_line === 'number'
      ? { toLine: rec.to_line }
      : typeof rec.toLine === 'number'
        ? { toLine: rec.toLine }
        : {}),
    ...(typeof rec.match_strategy === 'string'
      ? { matchStrategy: rec.match_strategy }
      : typeof rec.matchStrategy === 'string'
        ? { matchStrategy: rec.matchStrategy }
        : {}),
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
}

function normalizeProvenanceList(
  raw: unknown,
): FrontendProvenanceItem[] {
  if (!Array.isArray(raw)) return [];
  const items: FrontendProvenanceItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const repo = typeof rec.repo === 'string' ? rec.repo.trim() : '';
    const path = typeof rec.path === 'string' ? rec.path.trim() : '';
    const commitSha =
      typeof rec.commit_sha === 'string' && rec.commit_sha.trim()
        ? rec.commit_sha.trim()
        : typeof rec.commitSha === 'string' && rec.commitSha.trim()
          ? rec.commitSha.trim()
          : '';
    const url = typeof rec.url === 'string' ? rec.url.trim() : '';
    if (
      !repo ||
      !path ||
      !commitSha ||
      (!url.startsWith('https://') && !url.startsWith('http://'))
    ) {
      continue;
    }
    items.push({ repo, path, commitSha, url });
  }
  return items;
}

export function mapArtifactsToWidgets(
  rawArtifacts: unknown,
): FrontendResponseWidget[] {
  if (
    !rawArtifacts ||
    typeof rawArtifacts !== 'object' ||
    Array.isArray(rawArtifacts)
  ) {
    return [];
  }
  const artifacts = rawArtifacts as Record<string, unknown>;
  const widgets: FrontendResponseWidget[] = [];

  if (
    Array.isArray(artifacts.editor_patches) &&
    artifacts.editor_patches.length > 0
  ) {
    const patches = artifacts.editor_patches
      .map((item, idx) => normalizeEditorPatch(item, idx))
      .filter((p): p is FrontendEditorPatchItem => p !== null);
    const provenance = normalizeProvenanceList(artifacts.provenance);
    if (patches.length > 0) {
      widgets.push({
        type: 'editor_patches',
        title:
          patches.length === 1
            ? 'Proposed LaTeX Edit'
            : `Proposed LaTeX Edits (${patches.length})`,
        patches,
        ...(provenance.length > 0 ? { provenance } : {}),
      });
    }
  }

  if (Array.isArray(artifacts.widgets)) {
    for (const rawWidget of artifacts.widgets) {
      if (
        !rawWidget ||
        typeof rawWidget !== 'object' ||
        Array.isArray(rawWidget)
      ) {
        continue;
      }
      const rec = rawWidget as Record<string, unknown>;
      const wType = typeof rec.type === 'string' ? rec.type : '';
      const wTitle = typeof rec.title === 'string' ? rec.title.trim() : '';
      if (
        wTitle &&
        (wType === 'work_item_overview' ||
          wType === 'metric_summary' ||
          wType === 'editor_patches')
      ) {
        widgets.push(rec);
      }
    }
  }

  if (
    artifacts.revertible_turn &&
    typeof artifacts.revertible_turn === 'object' &&
    !Array.isArray(artifacts.revertible_turn)
  ) {
    const rt = artifacts.revertible_turn as Record<string, unknown>;
    const traceId = typeof rt.trace_id === 'string' ? rt.trace_id.trim() : '';
    const count = typeof rt.count === 'number' ? rt.count : 0;
    const items = Array.isArray(rt.items) ? rt.items : [];
    const spaceId = typeof rt.space_id === 'string' ? rt.space_id.trim() : '';
    if (traceId && count > 0) {
      widgets.push({
        type: 'revertible_turn',
        title: 'Undo AI changes',
        data: {
          traceId,
          ...(spaceId ? { spaceId } : {}),
          count,
          items,
        },
      });
    }
  }

  return widgets;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function normalizeHitlInterrupts(
  rawInterrupts: unknown[],
): FrontendHitlInterrupt[] {
  return rawInterrupts.map((entry, idx) => {
    const rec = asRecord(entry) ?? {};
    const nestedRequests = Array.isArray(rec.action_requests)
      ? rec.action_requests
      : null;
    const firstReq = nestedRequests ? asRecord(nestedRequests[0]) : null;

    const tool =
      (typeof rec.tool === 'string' && rec.tool) ||
      (typeof rec.name === 'string' && rec.name) ||
      (typeof firstReq?.name === 'string' && firstReq.name) ||
      undefined;

    const args =
      asRecord(rec.args) ||
      asRecord(rec.arguments) ||
      asRecord(firstReq?.args) ||
      asRecord(firstReq?.arguments) ||
      undefined;

    const description =
      (typeof rec.description === 'string' && rec.description) ||
      (typeof firstReq?.description === 'string' && firstReq.description) ||
      undefined;

    const rawAllowed = Array.isArray(rec.allowedDecisions)
      ? rec.allowedDecisions
      : Array.isArray(rec.allowed_decisions)
        ? rec.allowed_decisions
        : ['approve', 'reject'];

    const allowedDecisions = rawAllowed.filter(
      (d): d is 'approve' | 'reject' | 'edit' =>
        d === 'approve' || d === 'reject' || d === 'edit',
    );

    const id =
      (typeof rec.id === 'string' && rec.id) ||
      (typeof rec.interrupt_id === 'string' && rec.interrupt_id) ||
      `hitl-${idx}-${tool ?? 'action'}`;

    return {
      id,
      ...(tool ? { tool } : {}),
      ...(description ? { description } : {}),
      ...(args ? { args } : {}),
      allowedDecisions:
        allowedDecisions.length > 0 ? allowedDecisions : ['approve', 'reject'],
      raw: entry,
    };
  });
}

export function translateEngineSseFrame(
  eventName: string,
  rawData: string,
): TranslatedSseFrame {
  if (rawData === '[DONE]') {
    return { clientFrames: [encodeSseEvent({ type: 'done' })], finished: true };
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
        encodeSseEvent({
          type: 'meta',
          agent: routeLabel || mode,
          intent: mode,
        }),
      ];
      if (targets.length > 0) {
        frames.push(
          encodeSseEvent({
            type: 'agent-handoff',
            to: routeLabel,
            parallel: targets.length > 1,
          }),
        );
      }
      return { clientFrames: frames, route: routeLabel || mode };
    }

    case 'agent.started': {
      const agent =
        typeof payload?.agent === 'string' ? payload.agent : undefined;
      return {
        clientFrames: [
          encodeSseEvent({
            type: 'thinking',
            ...(agent ? { agent } : {}),
          }),
        ],
      };
    }

    case 'agent.finished': {
      const agent =
        typeof payload?.agent === 'string' ? payload.agent : undefined;
      return {
        clientFrames: [
          encodeSseEvent({
            type: 'agent-done',
            ...(agent ? { agent } : {}),
            status: 'done',
            success: true,
          }),
        ],
      };
    }

    case 'tool.called': {
      const tool = typeof payload?.tool === 'string' ? payload.tool : 'tool';
      const agent =
        typeof payload?.agent === 'string' ? payload.agent : undefined;
      const input = asRecord(payload?.input) ?? undefined;
      return {
        clientFrames: [
          encodeSseEvent({
            type: 'tool-start',
            tool,
            ...(agent ? { agent } : {}),
            ...(input ? { input } : {}),
          }),
        ],
      };
    }

    case 'tool.completed': {
      const tool = typeof payload?.tool === 'string' ? payload.tool : 'tool';
      const agent =
        typeof payload?.agent === 'string' ? payload.agent : undefined;
      const isError = payload?.status === 'error';
      const error =
        typeof payload?.error === 'string' && payload.error.trim()
          ? payload.error.trim()
          : undefined;
      return {
        clientFrames: [
          encodeSseEvent({
            type: 'tool-end',
            tool,
            ...(agent ? { agent } : {}),
            status: isError ? 'error' : 'done',
            success: !isError,
            ...(error ? { error } : {}),
          }),
        ],
      };
    }

    case 'editor.patch_preview': {
      const patch = normalizeEditorPatch(payload?.patch, 0);
      if (!patch) return { clientFrames: [] };
      const agent =
        typeof payload?.agent === 'string' ? payload.agent : 'editor_agent';
      return {
        clientFrames: [
          encodeSseEvent({
            type: 'editor-patch-preview',
            agent,
            patch,
            ...(typeof payload?.total_patches === 'number'
              ? { totalPatches: payload.total_patches }
              : {}),
          }),
        ],
      };
    }

    case 'reasoning.delta': {
      const delta = typeof payload?.delta === 'string' ? payload.delta : '';
      if (!delta) return { clientFrames: [] };
      return {
        clientFrames: [encodeSseEvent({ type: 'reasoning-delta', delta })],
      };
    }

    case 'text.delta': {
      const delta = typeof payload?.delta === 'string' ? payload.delta : '';
      if (!delta) return { clientFrames: [] };
      return {
        clientFrames: [encodeSseEvent({ type: 'text-delta', delta })],
        deltaText: delta,
      };
    }

    case 'hitl.interrupted': {
      const rawInterrupts = Array.isArray(payload?.interrupts)
        ? payload.interrupts
        : [];
      const interrupts = normalizeHitlInterrupts(rawInterrupts);
      const interruptId = interrupts[0]?.id ?? `hitl-${Date.now()}`;
      return {
        clientFrames: [
          encodeSseEvent({
            type: 'hitl-interrupt',
            interruptId,
            interrupts,
          }),
          encodeSseEvent({ type: 'done' }),
        ],
        interrupts: rawInterrupts,
        finished: true,
      };
    }

    case 'run.finished': {
      const route =
        typeof payload?.route === 'string' ? payload.route : 'direct';
      const citations = normalizeRawCitations(payload?.citations);
      const sources = citations.map(mapCitationToSourceItem);
      const rawArtifacts = asRecord(payload?.artifacts) ?? undefined;
      const widgets = mapArtifactsToWidgets(rawArtifacts);
      return {
        clientFrames: [
          encodeSseEvent({
            type: 'meta',
            agent: route,
            sources,
            ...(widgets.length > 0 ? { widgets } : {}),
          }),
          encodeSseEvent({ type: 'done' }),
        ],
        route,
        citations,
        ...(rawArtifacts ? { artifacts: rawArtifacts } : {}),
        ...(widgets.length > 0 ? { widgets } : {}),
        finished: true,
      };
    }

    case 'run.cancelled': {
      const rawArtifacts = asRecord(payload?.artifacts) ?? undefined;
      const widgets = mapArtifactsToWidgets(rawArtifacts);
      return {
        clientFrames: [
          ...(widgets.length > 0
            ? [encodeSseEvent({ type: 'meta', widgets })]
            : []),
          encodeSseEvent({ type: 'done' }),
        ],
        ...(rawArtifacts ? { artifacts: rawArtifacts } : {}),
        ...(widgets.length > 0 ? { widgets } : {}),
        cancelled: true,
        finished: true,
      };
    }

    case 'run.error': {
      const errorMessage =
        typeof payload?.message === 'string'
          ? payload.message
          : typeof payload?.error === 'string'
            ? payload.error
            : 'AI runtime stream error';
      return {
        clientFrames: [
          encodeSseEvent({
            type: 'agent-done',
            status: 'error',
            error: errorMessage,
            success: false,
          }),
          encodeSseEvent({ type: 'error', message: errorMessage }),
          encodeSseEvent({ type: 'done' }),
        ],
        finished: true,
      };
    }

    default: {
      if (payload && typeof payload.delta === 'string') {
        return {
          clientFrames: [
            encodeSseEvent({ type: 'text-delta', delta: payload.delta }),
          ],
          deltaText: payload.delta,
        };
      }
      return { clientFrames: [] };
    }
  }
}
