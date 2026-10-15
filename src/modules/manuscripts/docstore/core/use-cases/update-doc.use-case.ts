/**
 * modules/manuscripts/docstore/core/use-cases/update-doc.use-case.ts
 * Updates document text lines with OCC revision check and Skip No-op write optimization.
 * Matches Overleaf DocManager.updateDoc semantics.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { IDocRepository } from '@/modules/manuscripts/docstore/core/ports/doc-repository.port';
import { IDocHasher } from '@/modules/manuscripts/docstore/core/ports/doc-hasher.port';
import { computeDocSha256 } from '@/modules/manuscripts/docstore/domain/doc-hasher';
import { TextDoc } from '@/modules/manuscripts/docstore/core/domain/text-doc.entity';
import { DocRanges } from '@/modules/manuscripts/docstore/core/domain/doc-range.vo';
import { DocNotFoundError } from '@/modules/manuscripts/docstore/core/domain/doc-errors';
import { LineArrayEngine } from '@/modules/manuscripts/docstore/core/adapters/engine/line-array.engine';
import { NoopDiffChecker } from '@/modules/manuscripts/docstore/core/adapters/engine/noop-diff.checker';
import { DocstoreMetrics } from '@/modules/manuscripts/docstore/core/adapters/telemetry/docstore.metrics';

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
    @Optional() private readonly docHasher?: IDocHasher,
  ) {}

  public async execute(
    projectId: string,
    docId: string,
    lines: string[],
    version?: number,
    ranges?: DocRanges,
    expectedRev?: number,
  ): Promise<UpdateDocResult> {
    // 1. Validate lines size and defensive null byte check
    LineArrayEngine.validateLinesSize(lines);

    // 2. Fetch current document state
    const currentDoc = await this.docRepository.getDoc(projectId, docId);
    if (!currentDoc) {
      throw new DocNotFoundError(
        `Document ${docId} not found in project ${projectId}`,
      );
    }

    const resolvedVersion =
      version !== undefined ? version : (currentDoc.version ?? 0) + 1;

    // 3. Skip No-op updates (Overleaf optimization)
    const diff = NoopDiffChecker.checkDiff(
      currentDoc,
      lines,
      resolvedVersion,
      ranges,
    );
    if (!diff.shouldUpdate) {
      this.logger.debug(
        `Document ${docId} lines and ranges have not changed - skipping database write`,
      );
      DocstoreMetrics.recordNoopSkip();
      return {
        doc: currentDoc,
        modified: false,
        rev: currentDoc.rev,
      };
    }

    // 4. Compute updated hash fingerprint for CLSI incremental sync via pure domain function
    const hash = this.docHasher
      ? this.docHasher.computeHash(lines)
      : computeDocSha256(lines);

    // 5. Commit atomic update with OCC verification
    const { doc, modified } = await this.docRepository.updateDoc(
      projectId,
      docId,
      {
        lines,
        version: resolvedVersion,
        ranges,
        hash,
        expectedRev,
      },
    );

    return {
      doc,
      modified,
      rev: doc.rev,
    };
  }
}
