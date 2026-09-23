/**
 * modules/manuscripts/docstore/core/use-cases/patch-doc.use-case.ts
 * Patches document metadata (soft delete, rename).
 * Matches Overleaf HttpController.patchDoc semantics.
 */

import { Injectable, Logger } from '@nestjs/common';
import { IDocRepository, PatchDocData } from '../ports/doc-repository.port';
import { TextDoc } from '../domain/text-doc.entity';

@Injectable()
export class PatchDocUseCase {
  private readonly logger = new Logger(PatchDocUseCase.name);

  constructor(private readonly docRepository: IDocRepository) {}

  public async execute(
    projectId: string,
    docId: string,
    patch: PatchDocData
  ): Promise<TextDoc> {
    return await this.docRepository.patchDoc(projectId, docId, patch);
  }
}
