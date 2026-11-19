import type { FastifyReply } from 'fastify';
import type { AiHealthStatus } from '../ai.type';
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
} from './types/engine.type';

export interface IAiEnginePort {
  health(): Promise<AiHealthStatus>;
  listAgents(): Promise<EngineAgentInfo[]>;
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
  deleteThread(spaceId: string, chatId: string): Promise<EngineDeleteResponse>;
  deleteSpaceThreads(spaceId: string): Promise<EngineDeleteResponse>;
  ingestDocument(input: EngineIngestInput): Promise<EngineIngestResponse>;
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
