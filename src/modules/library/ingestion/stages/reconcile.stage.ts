import { Injectable, Logger } from '@nestjs/common';
import {
  MetadataCandidate,
  ReconciliationDecision,
} from '../types/metadata-candidate.types';
import { ReconciliationPolicy } from '../policies/reconciliation.policy';

@Injectable()
export class ReconcileStage {
  private readonly logger = new Logger(ReconcileStage.name);

  constructor(private readonly reconciler: ReconciliationPolicy) {}

  /**
   * Executes deterministic reconciliation over candidates.
   */
  execute(candidates: MetadataCandidate[]): Promise<ReconciliationDecision> {
    return Promise.resolve(this.reconciler.reconcile(candidates));
  }
}
