/**
 * modules/manuscripts/docstore/core/use-cases/peek-doc.use-case.ts
 * Zero-write document peek: Reads lines on the fly without writing back to database.
 * Matches Overleaf HttpController.peekDoc semantics.
 */

import { Injectable, Logger } from '@nestjs/common';
import { IDocRepository } from '../ports/doc-repository.port';
import { IDocPersistor } from '../ports/doc-persistor.port';
import { TextDoc } from '../domain/text-doc.entity';
import { DocNotFoundError } from '../domain/doc-errors';

export interface PeekDocResult {
  doc: TextDoc;
  status: 'active' | 'archived';
}

@Injectable()
export class PeekDocUseCase {
  private readonly logger = new Logger(PeekDocUseCase.name);

  constructor(
    private readonly docRepository: IDocRepository,
    private readonly docPersistor: IDocPersistor
  ) {}

  public async execute(projectId: string, docId: string): Promise<PeekDocResult> {
    const doc = await this.docRepository.getDoc(projectId, docId);

    if (!doc) {
      throw new DocNotFoundError(`Document ${docId} not found in project ${projectId}`);
    }

    if (!doc.inStorage) {
      return { doc, status: 'active' };
    }

    // Read directly from S3 stream on the fly without writing back to DB
    if (!doc.storageKey) {
      return { doc, status: 'archived' };
    }

    const stream = await this.docPersistor.getObjectStream(doc.storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawJson = Buffer.concat(chunks).toString('utf8');
    const parsed = JSON.parse(rawJson);
    const lines = Array.isArray(parsed.lines) ? parsed.lines : [];

    const peekedDoc = new TextDoc({
      id: doc.id,
      projectId: doc.projectId,
      path: doc.path,
      lines,
      rev: doc.rev,
      version: doc.version,
      ranges: parsed.ranges || doc.ranges,
      hash: doc.hash,
      sizeBytes: doc.sizeBytes,
      inStorage: true,
      storageKey: doc.storageKey,
      deleted: doc.deleted,
      deletedAt: doc.deletedAt,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    });

    return { doc: peekedDoc, status: 'archived' };
  }
}
