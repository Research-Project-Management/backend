/**
 * modules/manuscripts/docstore/core/use-cases/get-doc.use-case.ts
 * Use case to retrieve a single document, automatically hydrating lines from Cold Tier (S3) if needed.
 */

import { Injectable, Logger } from '@nestjs/common';
import { IDocRepository } from '../ports/doc-repository.port';
import { IDocPersistor } from '../ports/doc-persistor.port';
import { TextDoc } from '../domain/text-doc.entity';
import { DocNotFoundError, Md5MismatchError } from '../domain/doc-errors';
import * as crypto from 'crypto';

@Injectable()
export class GetDocUseCase {
  private readonly logger = new Logger(GetDocUseCase.name);

  constructor(
    private readonly docRepository: IDocRepository,
    private readonly docPersistor: IDocPersistor
  ) {}

  public async execute(
    projectId: string,
    docId: string,
    options?: { includeDeleted?: boolean }
  ): Promise<TextDoc> {
    const doc = await this.docRepository.getDoc(projectId, docId);

    if (!doc) {
      throw new DocNotFoundError(`Document ${docId} not found in project ${projectId}`);
    }

    if (doc.deleted && !options?.includeDeleted) {
      throw new DocNotFoundError(`Document ${docId} has been deleted`);
    }

    // If document is in Cold Storage tier (S3), unarchive and hydrate back into Database
    if (doc.inStorage && doc.storageKey) {
      this.logger.log(`Hydrating cold-tier document ${docId} from key ${doc.storageKey}`);
      const stream = await this.docPersistor.getObjectStream(doc.storageKey);
      const expectedMd5 = await this.docPersistor.getObjectMd5Hash(doc.storageKey);

      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawJson = Buffer.concat(chunks).toString('utf8');
      const actualMd5 = crypto.createHash('md5').update(rawJson).digest('hex');

      if (expectedMd5 && actualMd5 !== expectedMd5) {
        throw new Md5MismatchError('MD5 mismatch during document unarchival', {
          key: doc.storageKey,
          sourceMd5: expectedMd5,
          actualMd5,
        });
      }

      const parsed = JSON.parse(rawJson);
      const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
      const ranges = parsed.ranges || { changes: [], comments: [] };

      return await this.docRepository.unarchiveDoc(projectId, docId, lines, ranges);
    }

    return doc;
  }
}
