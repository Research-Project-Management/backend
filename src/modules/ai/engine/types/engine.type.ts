export type EngineMessageRole = 'user' | 'assistant' | 'system';

export interface EngineMessage {
  role: EngineMessageRole;
  content: string;
}

export interface EngineChatRequest {
  messages: EngineMessage[];
  space_id: string;
  chat_id?: string | null;
  stateless?: boolean;
  page_id?: string | null;
  document_ids?: string[];
  intent_hint?: string | null;
  context?: Record<string, unknown>;
  trace_id?: string;
  delegation_token?: string;
}

export interface EngineResumeRequest {
  decision: unknown;
  space_id: string;
  chat_id: string;
  page_id?: string | null;
  document_ids?: string[];
  trace_id?: string;
  delegation_token?: string;
}

export interface EngineCitation {
  index?: number;
  source_id: string;
  source_type?: string;
  title?: string;
  url?: string | null;
  page?: number | null;
  snippet?: string | null;
}

export interface FrontendSourceItem {
  index?: number;
  source?: string;
  title?: string;
  snippet?: string;
  url?: string;
  authors?: string;
  year?: number;
  page?: number;
}

export interface FrontendEditorPatchItem {
  id: string;
  fileId?: string | null;
  filePath: string;
  kind?: string;
  title: string;
  rationale?: string;
  searchText: string;
  replaceText: string;
  fromLine?: number;
  toLine?: number;
  matchStrategy?: string;
  warnings?: string[];
}

export interface FrontendProvenanceItem {
  repo: string;
  path: string;
  commitSha: string;
  url: string;
}

export interface FrontendEditorPatchesWidget extends Record<string, unknown> {
  type: 'editor_patches';
  title: string;
  patches: FrontendEditorPatchItem[];
  provenance?: FrontendProvenanceItem[];
}

export type FrontendResponseWidget =
  FrontendEditorPatchesWidget | Record<string, unknown>;

export interface EngineChatResponse {
  content: string;
  route: string;
  status: 'completed' | 'interrupted';
  citations: EngineCitation[];
  sources: FrontendSourceItem[];
  artifacts?: Record<string, unknown>;
  widgets?: FrontendResponseWidget[];
  interrupts: unknown[];
  usage: Record<string, unknown>;
  stateless?: boolean;
  trace_id: string;
}

export interface EngineAgentInfo {
  name: string;
  description: string;
  capabilities: string[];
  timeout_seconds: number;
}

export interface StreamCompletionResult {
  content: string;
  route: string;
  citations: EngineCitation[];
  sources: FrontendSourceItem[];
  artifacts?: Record<string, unknown>;
  widgets?: FrontendResponseWidget[];
  interrupts: unknown[];
  cancelled: boolean;
}

export interface StreamOptions {
  initialFrames?: string[];
  onComplete?: (result: StreamCompletionResult) => Promise<void> | void;
}

export interface EngineIngestInput {
  spaceId: string;
  sourceType: 'file' | 'upload' | 'library';
  sourceId: string;
  fileBuffer: Buffer;
  filename: string;
  mimeType: string;
  title?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface EngineIngestJobResponse {
  job_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  space_id: string;
  source_type: string;
  source_id: string;
  title: string;
  pages_parsed: number;
  chunks_indexed: number;
  error?: string;
}

export interface EngineIngestResponse {
  space_id: string;
  source_type: string;
  source_id: string;
  title: string;
  pages_parsed: number;
  chunks_indexed: number;
}

export interface EngineKnowledgeSearchInput {
  space_id: string;
  query: string;
  limit?: number;
  source_types?: string[];
  source_ids?: string[];
}

export interface EngineKnowledgeSearchHit {
  source_id: string;
  source_type: string;
  title: string;
  content: string;
  score: number;
  page?: number | null;
  url?: string | null;
  metadata?: Record<string, unknown>;
}

export interface EngineDeleteResponse {
  space_id: string;
  deleted: boolean;
  source_type?: string | null;
  source_id?: string | null;
  chat_id?: string | null;
  deleted_threads?: number;
}

export interface EngineRevertStepResult {
  tool: string;
  entity_id: string;
  label?: string;
  status: 'reverted' | 'already_gone' | 'failed';
  error?: string;
}

export interface EngineTurnRevertResponse {
  trace_id: string;
  space_id: string;
  reverted_count: number;
  results: EngineRevertStepResult[];
}

export interface EngineCheckpointSummary {
  checkpoint_id: string;
  parent_checkpoint_id?: string | null;
  created_at?: string | null;
  step?: number | null;
  message_count: number;
  route?: string | null;
  preview: string;
}

export interface EngineThreadCheckpointsResponse {
  chat_id: string;
  space_id: string;
  checkpoints: EngineCheckpointSummary[];
}

export interface EngineThreadRewindResponse {
  chat_id: string;
  space_id: string;
  target_checkpoint_id: string;
  new_checkpoint_id: string;
  message_count: number;
  reverted_count: number;
  revert_results: EngineRevertStepResult[];
}

export interface EngineModelInfo {
  id: string;
  label: string;
  provider: string;
  tier: 'auto' | 'fast' | 'balanced' | 'pro';
  description: string;
  is_default: boolean;
}

export interface FrontendHitlInterrupt {
  id: string;
  tool?: string;
  description?: string;
  args?: Record<string, unknown>;
  allowedDecisions: Array<'approve' | 'reject' | 'edit'>;
  raw?: unknown;
}

export type FluxClientSseEvent =
  | {
      type: 'meta';
      chatId?: string;
      title?: string;
      agent?: string;
      intent?: string;
      sources?: FrontendSourceItem[];
      widgets?: FrontendResponseWidget[];
    }
  | {
      type: 'text-delta';
      delta: string;
    }
  | {
      type: 'reasoning-delta';
      delta: string;
    }
  | {
      type: 'agent-handoff';
      to: string;
      parallel?: boolean;
    }
  | {
      type: 'thinking';
      agent?: string;
    }
  | {
      type: 'agent-done';
      agent?: string;
      status?: 'done' | 'error';
      error?: string;
      success?: boolean;
    }
  | {
      type: 'tool-start';
      tool: string;
      agent?: string;
      input?: Record<string, unknown>;
    }
  | {
      type: 'tool-end';
      tool: string;
      agent?: string;
      status?: 'done' | 'error';
      output?: Record<string, unknown>;
      error?: string;
      success?: boolean;
      count?: number;
      action?: string;
      widgets?: FrontendResponseWidget[];
    }
  | {
      type: 'hitl-interrupt';
      interruptId: string;
      interrupts: FrontendHitlInterrupt[];
    }
  | {
      type: 'editor-patch-preview';
      agent?: string;
      patch: FrontendEditorPatchItem;
      totalPatches?: number;
    }
  | {
      type: 'error';
      message: string;
    }
  | {
      type: 'done';
    };

export interface TranslatedSseFrame {
  clientFrames: string[];
  deltaText?: string;
  route?: string;
  citations?: EngineCitation[];
  artifacts?: Record<string, unknown>;
  widgets?: FrontendResponseWidget[];
  interrupts?: unknown[];
  finished?: boolean;
  cancelled?: boolean;
}
