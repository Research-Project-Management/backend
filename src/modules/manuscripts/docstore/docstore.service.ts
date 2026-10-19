/**
 * modules/manuscripts/docstore/docstore.service.ts
 * Deep Module Service orchestrating document store persistence, SHA-256 hashing,
 * cold-tier S3 archive/unarchive, track-change line mutations, and LaTeX export transpilation.
 */

import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { Readable } from 'stream';
import * as crypto from 'crypto';
import { mapWithConcurrency } from '@/core';
import { WorkspaceFile } from '@/modules/manuscripts/core';
import {
  IDocRepository,
  IDocPersistor,
  IDocHasher,
  TextDoc,
  DocRanges,
  LineArrayEngine,
  NoopDiffChecker,
  DocstoreMetrics,
  DocstoreMetricsSummary,
  DocNotFoundError,
  Md5MismatchError,
  NullByteDetectedError,
  computeDocSha256,
} from './domain';
import {
  TrackChangeSuggestionSpec,
  applySuggestionToLines,
  applyBatchSuggestionsToLines,
} from '@/modules/manuscripts/track-changes/domain';
import {
  IncludedProjectDoc,
  ExportFormattedDocResult,
  transpileLatexDocumentForExport,
} from '@/modules/manuscripts/export-import/domain';
import {
  CreateDocDto,
  UpdateDocDto,
  PatchDocDto,
  DocResponseDto,
} from './dto/doc.dto';

const COLD_HYDRATION_CONCURRENCY = 8;

export interface PeekDocResult {
  doc: TextDoc;
  status: 'active' | 'archived';
}

export interface UpdateDocResult {
  doc: TextDoc;
  modified: boolean;
  rev: number;
}

export type { ExportFormattedDocResult };

@Injectable()
export class DocstoreService {
  private readonly logger = new Logger(DocstoreService.name);
  private readonly docPersistor: IDocPersistor;

  constructor(
    private readonly docRepository: IDocRepository,
    @Optional() private readonly docHasher?: IDocHasher,
    @Optional() @Inject(IDocPersistor) docPersistor?: IDocPersistor,
  ) {
    this.docPersistor =
      docPersistor ?? (docRepository as unknown as IDocPersistor);
  }

  public mapToDto(doc: TextDoc): DocResponseDto {
    return {
      _id: doc.id,
      id: doc.id,
      projectId: doc.projectId,
      path: doc.path,
      lines: doc.lines,
      rev: doc.rev,
      version: doc.version,
      ranges: doc.ranges,
      hash: doc.hash,
      sizeBytes: doc.sizeBytes,
      inStorage: doc.inStorage,
      deleted: doc.deleted,
    };
  }

  private async getDocEntity(
    projectId: string,
    docId: string,
    options?: { includeDeleted?: boolean },
  ): Promise<TextDoc> {
    const doc = await this.docRepository.getDoc(projectId, docId);

    if (!doc) {
      throw new DocNotFoundError(
        `Document ${docId} not found in project ${projectId}`,
      );
    }

    if (doc.deleted && !options?.includeDeleted) {
      throw new DocNotFoundError(`Document ${docId} has been deleted`);
    }

    if (doc.inStorage && doc.storageKey) {
      this.logger.log(
        `Hydrating cold-tier document ${docId} from key ${doc.storageKey}`,
      );
      const stream = await this.docPersistor.getObjectStream(doc.storageKey);
      const expectedMd5 = await this.docPersistor.getObjectMd5Hash(
        doc.storageKey,
      );

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

      return await this.docRepository.unarchiveDoc(
        projectId,
        docId,
        lines,
        ranges,
      );
    }

    return doc;
  }

  private async getAllDocEntities(projectId: string): Promise<TextDoc[]> {
    const docs = await this.docRepository.getAllDocs(projectId);
    return await mapWithConcurrency<TextDoc, TextDoc>(
      docs,
      COLD_HYDRATION_CONCURRENCY,
      async (doc: TextDoc) => {
        if (doc.inStorage) {
          return await this.getDocEntity(projectId, doc.id);
        }
        return doc;
      },
    );
  }

  public async getDoc(
    projectId: string,
    docId: string,
    options?: { includeDeleted?: boolean },
  ): Promise<DocResponseDto> {
    const doc = await this.getDocEntity(projectId, docId, options);
    return this.mapToDto(doc);
  }

  public async getDocById(docId: string): Promise<DocResponseDto | null> {
    const doc = await this.docRepository.getDocById(docId);
    if (!doc) return null;
    return this.mapToDto(doc);
  }

  public async peekDoc(
    projectId: string,
    docId: string,
  ): Promise<PeekDocResult> {
    const doc = await this.docRepository.getDoc(projectId, docId);

    if (!doc) {
      throw new DocNotFoundError(
        `Document ${docId} not found in project ${projectId}`,
      );
    }

    if (!doc.inStorage) {
      return { doc, status: 'active' };
    }

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

  public async getRawDoc(projectId: string, docId: string): Promise<string> {
    const doc = await this.getDocEntity(projectId, docId);
    return doc.toRawText();
  }

  public async getAllDocs(projectId: string): Promise<DocResponseDto[]> {
    const docs = await this.getAllDocEntities(projectId);
    return docs.map((d) => this.mapToDto(d));
  }

  public async getAllDeletedDocs(projectId: string): Promise<DocResponseDto[]> {
    const docs = await this.docRepository.getAllDeletedDocs(projectId);
    return docs.map((d) => this.mapToDto(d));
  }

  public async createDoc(
    projectId: string,
    dto: CreateDocDto,
  ): Promise<DocResponseDto> {
    const lines =
      dto.lines || (dto.text ? LineArrayEngine.textToLines(dto.text) : ['']);
    LineArrayEngine.validateLinesSize(lines);

    const hash = this.docHasher
      ? this.docHasher.computeHash(lines)
      : computeDocSha256(lines);
    const doc = await this.docRepository.createDoc({
      projectId,
      path: dto.path,
      lines,
      version: dto.version ?? 0,
      ranges: dto.ranges,
      hash,
    });

    return this.mapToDto(doc);
  }

  public async updateDoc(
    projectId: string,
    docId: string,
    dto: UpdateDocDto,
  ): Promise<UpdateDocResult> {
    const lines = dto.lines;
    const version = dto.version;
    const ranges = dto.ranges;
    const expectedRev = dto.expectedRev ?? dto.rev;

    LineArrayEngine.validateLinesSize(lines);

    const currentDoc = await this.docRepository.getDoc(projectId, docId);
    if (!currentDoc) {
      throw new DocNotFoundError(
        `Document ${docId} not found in project ${projectId}`,
      );
    }

    const resolvedVersion =
      version !== undefined ? version : (currentDoc.version ?? 0) + 1;

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

    const hash = this.docHasher
      ? this.docHasher.computeHash(lines)
      : computeDocSha256(lines);

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

  public async patchDoc(
    projectId: string,
    docId: string,
    dto: PatchDocDto,
  ): Promise<DocResponseDto> {
    const doc = await this.docRepository.patchDoc(projectId, docId, {
      deleted: dto.deleted,
      name: dto.name ?? dto.path,
      deletedAt: dto.deletedAt ? new Date(dto.deletedAt) : undefined,
    });
    return this.mapToDto(doc);
  }

  public async applySuggestionsToDoc(
    projectId: string,
    docId: string,
    lines: string[],
    currentVersion: number,
    suggestions: TrackChangeSuggestionSpec | TrackChangeSuggestionSpec[],
  ): Promise<{ lines: string[]; result: UpdateDocResult }> {
    const mutatedLines = Array.isArray(suggestions)
      ? applyBatchSuggestionsToLines([...lines], suggestions)
      : applySuggestionToLines([...lines], suggestions);
    const result = await this.updateDoc(projectId, docId, {
      lines: mutatedLines,
      version: (currentVersion || 0) + 1,
    });
    return { lines: mutatedLines, result };
  }

  public transpileDocumentForExport(params: {
    rawFilename: string;
    content: string;
    format: string;
    projectDocs?: IncludedProjectDoc[];
  }): ExportFormattedDocResult {
    return transpileLatexDocumentForExport(params);
  }

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
      throw new NullByteDetectedError(
        `Null byte detected when archiving doc ${docId}`,
      );
    }

    const key = `${projectId}/${doc.id}.json`;
    const sourceMd5 = crypto.createHash('md5').update(payload).digest('hex');
    const stream = Readable.from(Buffer.from(payload, 'utf8'));
    const clearLines = this.docPersistor.isDurableStorageConfigured
      ? this.docPersistor.isDurableStorageConfigured()
      : true;

    await this.docPersistor.sendStream(key, stream, { sourceMd5 });
    await this.docRepository.markAsArchived(
      projectId,
      doc.id,
      key,
      doc.rev,
      clearLines,
    );
    this.logger.log(`Archived single document ${docId} to S3 cold tier`);
  }

  public async isDocDeleted(
    projectId: string,
    docId: string,
  ): Promise<boolean> {
    const doc = await this.getDocEntity(projectId, docId, {
      includeDeleted: true,
    });
    return doc.deleted;
  }

  public async getAllRanges(
    projectId: string,
  ): Promise<{ _id: string; ranges: DocRanges }[]> {
    const docs = await this.getAllDocEntities(projectId);
    return docs.map((d) => ({
      _id: d.id,
      ranges: d.ranges,
    }));
  }

  public async archiveAllDocs(projectId: string): Promise<number> {
    const docs = await this.docRepository.getAllDocs(projectId);
    let count = 0;
    const clearLines = this.docPersistor.isDurableStorageConfigured
      ? this.docPersistor.isDurableStorageConfigured()
      : true;

    for (const doc of docs) {
      if (doc.inStorage) continue;

      const payload = JSON.stringify({
        lines: doc.lines,
        ranges: doc.ranges,
        schema_v: 1,
      });

      if (payload.indexOf('\u0000') !== -1) {
        throw new NullByteDetectedError(
          `Null byte detected when archiving doc ${doc.id}`,
        );
      }

      const key = `${projectId}/${doc.id}.json`;
      const sourceMd5 = crypto.createHash('md5').update(payload).digest('hex');
      const stream = Readable.from(Buffer.from(payload, 'utf8'));

      await this.docPersistor.sendStream(key, stream, { sourceMd5 });
      await this.docRepository.markAsArchived(
        projectId,
        doc.id,
        key,
        doc.rev,
        clearLines,
      );
      count++;
    }

    this.logger.log(
      `Archived ${count} documents for project ${projectId} to S3 cold tier`,
    );
    return count;
  }

  public async unArchiveAllDocs(projectId: string): Promise<number> {
    const docs = await this.docRepository.getAllDocs(projectId);
    let count = 0;

    for (const doc of docs) {
      if (doc.inStorage) {
        await this.getDocEntity(projectId, doc.id);
        count++;
      }
    }

    this.logger.log(`Unarchived ${count} documents for project ${projectId}`);
    return count;
  }

  public async destroyAllDocs(projectId: string): Promise<number> {
    return await this.docRepository.destroyAllDocs(projectId);
  }

  public async getAsWorkspaceFiles(
    projectId: string,
  ): Promise<WorkspaceFile[]> {
    const docs = await this.getAllDocEntities(projectId);
    return docs.map((doc) => doc.toWorkspaceFile());
  }

  public getPrometheusMetrics(): string {
    return DocstoreMetrics.toPrometheus();
  }

  public getMetricsSummary(): DocstoreMetricsSummary {
    return DocstoreMetrics.getSummary();
  }
}
