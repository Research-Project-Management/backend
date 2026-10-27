import { IngestionStageName } from '@/modules/library/ingestion/domain/ingestion-run.aggregate';
import { IngestionSubmissionEnvelope } from './submission.types';
import { MetadataCandidate } from './metadata-candidate.types';
import { ItemMetadata } from './metadata.types';
import { CommitStageOptions } from '@/modules/library/ingestion/stages/commit.stage';

/**
 * Strict Stage Contract for the Ingestion Workflow Pattern.
 *
 * Each stage enforces:
 * 1. Single Responsibility (SRP): Performs one discrete transformation.
 * 2. Deterministic State Progression: Output of Stage N is the verified input for Stage N+1.
 * 3. Anti-Leaping / Non-Bypassing: Stages cannot jump tiers or bypass subsequent validation.
 */
export interface IWorkflowStage<TInput, TOutput> {
  readonly stageName: IngestionStageName;
  execute(input: TInput): Promise<TOutput>;
}

export interface IdentifyStageInput {
  runId: string;
  payload: IngestionSubmissionEnvelope['payload'];
  scopeId?: string;
  userId?: string;
  projectId?: string;
}

export interface EnrichStageInput {
  scopeId: string;
  candidates: MetadataCandidate[];
}

export interface MatchStageInput {
  scope: { userId?: string; projectId?: string | null } | string;
  proposedItem?: ItemMetadata;
}

export interface CommitStageInput {
  scopeId: string | { userId?: string; projectId?: string | null };
  item: ItemMetadata;
  options?: CommitStageOptions;
}

