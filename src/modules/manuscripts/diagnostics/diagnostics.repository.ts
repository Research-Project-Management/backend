/**
 * modules/manuscripts/diagnostics/diagnostics.repository.ts
 * Direct repository for LaTeX error knowledge base rules and project document loading for diagnostics.
 */

import { Injectable, Optional } from '@nestjs/common';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { IErrorExplainerPort } from './core/ports/error-explainer.port';
import { ErrorExplanationVo, ErrorKnowledgeBase } from './domain';

@Injectable()
export class DiagnosticsRepository implements IErrorExplainerPort {
  private readonly knowledgeBase = new ErrorKnowledgeBase();

  constructor(@Optional() private readonly docstoreService?: DocstoreService) {}

  public explain(message: string, context?: string): ErrorExplanationVo | null {
    return this.knowledgeBase.explain(message, context);
  }

  public getByCode(code: string): ErrorExplanationVo | null {
    return this.knowledgeBase.getByCode(code);
  }

  public requireByCode(code: string): ErrorExplanationVo {
    return this.knowledgeBase.requireByCode(code);
  }

  public getAllRules(): ErrorExplanationVo[] {
    return this.knowledgeBase.getAllRules();
  }

  public async getProjectDocuments(
    projectId: string,
  ): Promise<Array<{ path?: string; lines?: string[] }>> {
    if (!this.docstoreService) {
      return [];
    }
    return await this.docstoreService.getAllDocs(projectId);
  }
}
