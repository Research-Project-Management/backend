import type { FastifyReply } from 'fastify';
import type { AiHealthStatus } from '../ai.type';
import type {
  EngineAgentInfo,
  EngineChatRequest,
  EngineChatResponse,
  EngineDeleteResponse,
  EngineIngestInput,
  EngineIngestJobResponse,
  EngineIngestResponse,
  EngineKnowledgeSearchHit,
  EngineKnowledgeSearchInput,
  EngineModelInfo,
  EngineResumeRequest,
  EngineThreadCheckpointsResponse,
  EngineThreadRewindResponse,
  EngineTurnRevertResponse,
  StreamOptions,
} from './types/engine.type';

export interface IAiEnginePort {
  health(): Promise<AiHealthStatus>;
  listAgents(): Promise<EngineAgentInfo[]>;
  listModels(): Promise<EngineModelInfo[]>;
  chatSync(request: EngineChatRequest): Promise<EngineChatResponse>;
  chatStream(
    request: EngineChatRequest,
    reply: FastifyReply,
    options?: StreamOptions,
  ): Promise<void>;
  resumeSync(request: EngineResumeRequest): Promise<EngineChatResponse>;
  resumeStream(
    request: EngineResumeRequest,
    reply: FastifyReply,
    options?: StreamOptions,
  ): Promise<void>;
  cancelThread(spaceId: string, chatId: string): Promise<void>;
  revertTurn(
    traceId: string,
    spaceId: string,
    authToken?: string,
    entityIds?: string[],
  ): Promise<EngineTurnRevertResponse>;
  listThreadCheckpoints(
    chatId: string,
    spaceId: string,
    limit?: number,
  ): Promise<EngineThreadCheckpointsResponse>;
  rewindThread(
    chatId: string,
    spaceId: string,
    checkpointId: string,
    authToken?: string,
    revertTraceIds?: string[],
  ): Promise<EngineThreadRewindResponse>;
  deleteThread(spaceId: string, chatId: string): Promise<EngineDeleteResponse>;
  deleteSpaceThreads(spaceId: string): Promise<EngineDeleteResponse>;
  ingestDocument(input: EngineIngestInput): Promise<EngineIngestResponse>;
  enqueueKnowledgeIngest(
    input: EngineIngestInput,
  ): Promise<EngineIngestJobResponse>;
  getKnowledgeJob(jobId: string): Promise<EngineIngestJobResponse>;
  searchKnowledge(
    input: EngineKnowledgeSearchInput,
  ): Promise<EngineKnowledgeSearchHit[]>;
  deleteKnowledgeSource(
    spaceId: string,
    sourceType: string,
    sourceId: string,
  ): Promise<EngineDeleteResponse>;
  deleteSpaceKnowledge(spaceId: string): Promise<EngineDeleteResponse>;
}
