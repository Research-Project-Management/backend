/**
 * diagnostics/core/adapters/explainer/knowledge-base-explainer.adapter.ts
 * Adapter delegating IErrorExplainerPort to pure domain ErrorKnowledgeBase.
 */

import { IErrorExplainerPort } from '@/modules/manuscripts/diagnostics/core/ports/error-explainer.port';
import { ErrorExplanationVo } from '@/modules/manuscripts/diagnostics/core/domain/value-objects/error-explanation.vo';
import { ErrorKnowledgeBase } from '@/modules/manuscripts/diagnostics/domain/compile-log.analyzer';

export class KnowledgeBaseExplainerAdapter implements IErrorExplainerPort {
  private readonly kb = new ErrorKnowledgeBase();

  public explain(message: string, context?: string): ErrorExplanationVo | null {
    return this.kb.explain(message, context);
  }

  public getByCode(code: string): ErrorExplanationVo | null {
    return this.kb.getByCode(code);
  }

  public getAllRules(): ErrorExplanationVo[] {
    return this.kb.getAllRules();
  }
}
