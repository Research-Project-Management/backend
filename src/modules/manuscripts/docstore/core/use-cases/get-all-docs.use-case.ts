/**
 * modules/manuscripts/docstore/core/use-cases/get-all-docs.use-case.ts
 * Bulk document retrieval for project compilation and zip export.
 * Seamlessly interfaces with CLSI Compiler by outputting WorkspaceFile[].
 */

import { Injectable, Logger } from '@nestjs/common';
import { IDocRepository } from '../ports/doc-repository.port';
import { TextDoc } from '../domain/text-doc.entity';
import { GetDocUseCase } from './get-doc.use-case';
import { WorkspaceFile } from '@/modules/manuscripts/clsi/core/ports/workspace.port';

@Injectable()
export class GetAllDocsUseCase {
  private readonly logger = new Logger(GetAllDocsUseCase.name);

  constructor(
    private readonly docRepository: IDocRepository,
    private readonly getDocUseCase: GetDocUseCase
  ) {}

  public async execute(projectId: string): Promise<TextDoc[]> {
    const docs = await this.docRepository.getAllDocs(projectId);

    // If any document is in Cold Storage, hydrate it
    const hydratedDocs = await Promise.all(
      docs.map(async (doc) => {
        if (doc.inStorage) {
          return await this.getDocUseCase.execute(projectId, doc.id);
        }
        return doc;
      })
    );

    return hydratedDocs;
  }

  /**
   * Directly exports project text documents into WorkspaceFile[] for CLSI compilation.
   */
  public async executeAsWorkspaceFiles(projectId: string): Promise<WorkspaceFile[]> {
    const docs = await this.execute(projectId);
    return docs.map((doc) => doc.toWorkspaceFile());
  }
}
