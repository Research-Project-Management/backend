/**
 * modules/manuscripts/docstore/core/use-cases/archive-project.use-case.ts
 * Manages cold-tier project archiving to S3 and restoration.
 * Matches Overleaf DocArchiveManager semantics.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Readable } from 'stream';
import * as crypto from 'crypto';
import { IDocRepository } from '../ports/doc-repository.port';
import { IDocPersistor } from '../ports/doc-persistor.port';
import { GetDocUseCase } from './get-doc.use-case';
import { NullByteDetectedError, DocNotFoundError } from '../domain/doc-errors';

@Injectable()
export class ArchiveProjectUseCase {
  private readonly logger = new Logger(ArchiveProjectUseCase.name);

  constructor(
    private readonly docRepository: IDocRepository,
    private readonly docPersistor: IDocPersistor,
    private readonly getDocUseCase: GetDocUseCase
  ) {}

  public async archiveDoc(projectId: string, docId: string): Promise<void> {
    const doc = await this.docRepository.getDoc(projectId, docId);
    if (!doc) {
      throw new DocNotFoundError(docId);
    }
    if (doc.inStorage) return;

    const payload = JSON.stringify({
      lines: doc.lines,
      ranges: doc.ranges,
      schema_v: 1,
    });

    if (payload.indexOf('\u0000') !== -1) {
      throw new NullByteDetectedError(`Null byte detected when archiving doc ${docId}`);
    }

    const key = `${projectId}/${doc.id}.json`;
    const sourceMd5 = crypto.createHash('md5').update(payload).digest('hex');
    const stream = Readable.from(Buffer.from(payload, 'utf8'));

    await this.docPersistor.sendStream(key, stream, { sourceMd5 });
    await this.docRepository.markAsArchived(projectId, doc.id, key, doc.rev);
    this.logger.log(`Archived single document ${docId} to S3 cold tier`);
  }

  public async archiveAllDocs(projectId: string): Promise<number> {
    const docs = await this.docRepository.getAllDocs(projectId);
    let count = 0;

    for (const doc of docs) {
      if (doc.inStorage) continue;

      const payload = JSON.stringify({
        lines: doc.lines,
        ranges: doc.ranges,
        schema_v: 1,
      });

      // Defensive check for null bytes
      if (payload.indexOf('\u0000') !== -1) {
        throw new NullByteDetectedError(`Null byte detected when archiving doc ${doc.id}`);
      }

      const key = `${projectId}/${doc.id}.json`;
      const sourceMd5 = crypto.createHash('md5').update(payload).digest('hex');
      const stream = Readable.from(Buffer.from(payload, 'utf8'));

      await this.docPersistor.sendStream(key, stream, { sourceMd5 });
      await this.docRepository.markAsArchived(projectId, doc.id, key, doc.rev);
      count++;
    }

    this.logger.log(`Archived ${count} documents for project ${projectId} to S3 cold tier`);
    return count;
  }

  public async unarchiveAllDocs(projectId: string): Promise<number> {
    const docs = await this.docRepository.getAllDocs(projectId);
    let count = 0;

    for (const doc of docs) {
      if (doc.inStorage) {
        await this.getDocUseCase.execute(projectId, doc.id);
        count++;
      }
    }

    this.logger.log(`Unarchived ${count} documents for project ${projectId}`);
    return count;
  }

  public async destroyAllDocs(projectId: string): Promise<number> {
    return await this.docRepository.destroyAllDocs(projectId);
  }
}
