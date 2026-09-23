/**
 * document-updater/core/adapters/external/docstore-bridge.adapter.ts
 * Driven Adapter implementing IDocstoreWriterPort by delegating to DocstoreService.
 */

import { Injectable, Logger } from '@nestjs/common';
import { BaseDocData, CommitResult, IDocstoreWriterPort } from '../../ports/docstore-writer.port';
import { DocstoreService } from '../../../../docstore/docstore.service';
import { DocModifiedError, DocNotFoundError } from '../../../../docstore/core/domain/doc-errors';
import { DocUpdaterConflictException } from '../../domain/exceptions/doc-updater-conflict.exception';

@Injectable()
export class DocstoreBridgeAdapter extends IDocstoreWriterPort {
  private readonly logger = new Logger(DocstoreBridgeAdapter.name);

  constructor(private readonly docstoreService: DocstoreService) {
    super();
  }

  public async fetchBaseDoc(projectId: string, docId: string): Promise<BaseDocData | null> {
    try {
      const doc = await this.docstoreService.getDoc(projectId, docId);
      return {
        docId: doc._id,
        projectId,
        lines: doc.lines,
        rev: doc.rev,
        version: doc.version,
      };
    } catch (err) {
      if (err instanceof DocNotFoundError) {
        return null;
      }
      throw err;
    }
  }

  public async commitDocUpdate(
    projectId: string,
    docId: string,
    lines: string[],
    rev: number,
  ): Promise<CommitResult> {
    try {
      const result = await this.docstoreService.updateDoc(projectId, docId, {
        lines,
        version: 0,
        expectedRev: rev,
      });

      return {
        docId,
        newRev: result.doc.rev,
        version: result.doc.version,
        hash: result.doc.hash,
      };
    } catch (err) {
      if (err instanceof DocModifiedError) {
        const expected = err.details?.rev ?? rev;
        const actual = err.details?.currentRev ?? rev + 1;
        throw new DocUpdaterConflictException(docId, expected, actual);
      }
      throw err;
    }
  }
}
