/**
 * modules/manuscripts/docstore/core/use-cases/update-doc.use-case.ts
 * Updates document text lines with OCC revision check and Skip No-op write optimization.
 * Matches Overleaf DocManager.updateDoc semantics.
 */

import { Injectable, Logger } from '@nestjs/common';
import { IDocRepository } from '../ports/doc-repository.port';
import { IDocHasher } from '../ports/doc-hasher.port';
import { TextDoc } from '../domain/text-doc.entity';
import { DocRanges } from '../domain/doc-range.vo';
import { DocNotFoundError } from '../domain/doc-errors';
import { LineArrayEngine } from '../adapters/engine/line-array.engine';
import { NoopDiffChecker } from '../adapters/engine/noop-diff.checker';
import { DocstoreMetrics } from '../adapters/telemetry/docstore.metrics';

export interface UpdateDocResult {
  doc: TextDoc;
  modified: boolean;
  rev: number;
}

@Injectable()
export class UpdateDocUseCase {
  private readonly logger = new Logger(UpdateDocUseCase.name);

  constructor(
    private readonly docRepository: IDocRepository,
    private readonly docHasher: IDocHasher
  ) {}

  public async execute(
    projectId: string,
    docId: string,
    lines: string[],
    version: number,
    ranges?: DocRanges,
    expectedRev?: number
  ): Promise<UpdateDocResult> {
    // 1. Validate lines size and defensive null byte check
    LineArrayEngine.validateLinesSize(lines);

    // 2. Fetch current document state
    const currentDoc = await this.docRepository.getDoc(projectId, docId);
    if (!currentDoc) {
      throw new DocNotFoundError(`Document ${docId} not found in project ${projectId}`);
    }

    // 3. Skip No-op updates (Overleaf optimization)
    const diff = NoopDiffChecker.checkDiff(currentDoc, lines, version, ranges);
    if (!diff.shouldUpdate) {
      this.logger.debug(`Document ${docId} lines and ranges have not changed - skipping database write`);
      DocstoreMetrics.recordNoopSkip();
      return {
        doc: currentDoc,
        modified: false,
        rev: currentDoc.rev,
      };
    }

    // 4. Compute updated hash fingerprint for CLSI incremental sync
    const hash = this.docHasher.computeHash(lines);

    // 5. Commit atomic update with OCC verification
    const { doc, modified } = await this.docRepository.updateDoc(projectId, docId, {
      lines,
      version,
      ranges,
      hash,
      expectedRev,
    });

    return {
      doc,
      modified,
      rev: doc.rev,
    };
  }
}
