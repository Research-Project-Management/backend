/**
 * modules/manuscripts/docstore/services/manuscript-search-replace.service.ts
 * Domain/Application service encapsulating project-wide full-text/regex search and batch replace
 * across manuscript documents with DocstoreService contentHash integrity and Yjs live sync.
 */

import {
  Injectable,
  Logger,
  Optional,
  BadRequestException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/core';
import { DocstoreService } from '../docstore.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LiveCollaborationPort } from '../core/ports/live-collaboration.port';
import { buildSearchRegex, replaceInText } from '../core/domain/text-replace';

export interface SearchDocumentsParams {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  useRegex?: boolean;
  fileIds?: string[];
  maxResults?: number;
}

export interface ReplaceDocumentsParams {
  query: string;
  replaceWith: string;
  fileIds?: string[];
  caseSensitive?: boolean;
  wholeWord?: boolean;
  useRegex?: boolean;
}

const isUuid = (val?: string | null): val is string =>
  typeof val === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

@Injectable()
export class ManuscriptSearchReplaceService {
  private readonly logger = new Logger(ManuscriptSearchReplaceService.name);
  private liveCollab: LiveCollaborationPort | null | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly docstoreService: DocstoreService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  private getLiveCollaboration(): LiveCollaborationPort | null {
    if (this.liveCollab !== undefined) return this.liveCollab;
    try {
      this.liveCollab =
        this.moduleRef?.get(LiveCollaborationPort, { strict: false }) ?? null;
    } catch {
      this.liveCollab = null;
    }
    return this.liveCollab;
  }

  private async syncLiveDoc(
    projectId: string,
    docId: string,
    lines: string[],
  ): Promise<boolean> {
    const live = this.getLiveCollaboration();
    if (!live) return false;
    try {
      return await live.applyExternalText(projectId, docId, lines.join('\n'));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to sync REST write into live session ${projectId}:${docId}: ${message}`,
      );
      return false;
    }
  }

  public async searchDocuments(projectId: string, body: SearchDocumentsParams) {
    const query = body?.query || '';
    if (!query || !isUuid(projectId)) {
      return {
        query,
        totalFiles: 0,
        totalMatches: 0,
        results: [],
        truncated: false,
      };
    }

    try {
      const re = buildSearchRegex(query, {
        caseSensitive: body?.caseSensitive,
        wholeWord: body?.wholeWord,
        useRegex: body?.useRegex,
      });

      const where: Prisma.ManuscriptDocWhereInput = {
        projectId,
        deleted: false,
      };
      if (Array.isArray(body?.fileIds) && body.fileIds.length > 0) {
        where.id = { in: body.fileIds.filter((id) => isUuid(id)) };
      }

      const [docs, rootNodes] = await Promise.all([
        this.prisma.manuscriptDoc.findMany({
          where,
          select: { id: true, path: true, lines: true },
        }),
        this.prisma.manuscriptNode
          .findMany({
            where: { projectId, isRootDoc: true },
            select: { docId: true },
          })
          .catch(() => [] as Array<{ docId: string | null }>),
      ]);

      const rootDocIds = new Set(
        rootNodes.map((n) => n.docId).filter((id): id is string => !!id),
      );

      const maxResults =
        typeof body?.maxResults === 'number' && body.maxResults > 0
          ? body.maxResults
          : 500;
      const results = [];
      let totalMatches = 0;
      let truncated = false;

      for (const doc of docs) {
        if (truncated) break;
        const lines = (doc.lines as string[]) || [];
        const matches = [];

        for (let i = 0; i < lines.length; i++) {
          if (truncated) break;
          const lineStr = lines[i] || '';
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(lineStr)) !== null) {
            if (totalMatches >= maxResults) {
              truncated = true;
              break;
            }
            const matchText = m[0];
            const matchStart = m.index;
            matches.push({
              line: i + 1,
              text: lineStr,
              matchStart,
              matchEnd: matchStart + matchText.length,
              snippet: lineStr,
            });
            totalMatches++;
            if (matchText.length === 0) {
              re.lastIndex++;
            }
          }
        }

        if (matches.length > 0) {
          const cleanPath = (doc.path || '').replace(/^\//, '');
          results.push({
            fileId: doc.id,
            fileName: doc.path || 'document.tex',
            isMainFile:
              rootDocIds.has(doc.id) ||
              doc.path === 'main.tex' ||
              cleanPath === 'main.tex',
            totalMatches: matches.length,
            matches,
          });
        }
      }

      return {
        query,
        totalFiles: results.length,
        totalMatches,
        results,
        truncated,
      };
    } catch {
      return {
        query,
        totalFiles: 0,
        totalMatches: 0,
        results: [],
        truncated: false,
      };
    }
  }

  public async replaceDocuments(
    projectId: string,
    body: ReplaceDocumentsParams,
  ) {
    const query = body?.query;
    const replaceWith = body?.replaceWith ?? '';
    if (!isUuid(projectId)) {
      throw new BadRequestException('A valid UUID is required for projectId');
    }
    if (!query) {
      throw new BadRequestException('query is required');
    }
    const opts = {
      caseSensitive: !!body?.caseSensitive,
      wholeWord: !!body?.wholeWord,
      useRegex: !!body?.useRegex,
    };
    try {
      buildSearchRegex(query, opts);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Invalid search pattern: ${message}`);
    }

    const where: Prisma.ManuscriptDocWhereInput = { projectId, deleted: false };
    if (Array.isArray(body?.fileIds) && body.fileIds.length > 0) {
      where.id = { in: body.fileIds.filter((id) => isUuid(id)) };
    }

    // Make sure in-memory collaborative edits are persisted before we read.
    const candidateIds = (
      await this.prisma.manuscriptDoc.findMany({ where, select: { id: true } })
    ).map((d) => d.id);
    const live = this.getLiveCollaboration();
    if (live && candidateIds.length > 0) {
      await live.flushDocs(projectId, candidateIds);
    }

    const docs = await this.prisma.manuscriptDoc.findMany({
      where: { id: { in: candidateIds } },
      select: { id: true, lines: true, version: true },
    });

    let totalOccurrencesReplaced = 0;
    const affectedFileIds: string[] = [];
    const failedFileIds: string[] = [];

    for (const doc of docs) {
      const rawContent = Array.isArray(doc.lines)
        ? (doc.lines as string[]).join('\n')
        : String(doc.lines ?? '');
      const { text: newContent, count } = replaceInText(
        rawContent,
        query,
        replaceWith,
        opts,
      );
      if (count === 0) continue;

      const lines = newContent.split('\n');
      try {
        const result = await this.docstoreService.updateDoc(projectId, doc.id, {
          lines,
          version: doc.version + 1,
        });
        await this.syncLiveDoc(projectId, doc.id, lines);
        totalOccurrencesReplaced += count;
        affectedFileIds.push(doc.id);

        if (this.eventEmitter) {
          try {
            this.eventEmitter.emit('manuscripts.project.event', {
              projectId,
              event: 'doc:content-updated',
              payload: {
                docId: doc.id,
                version: result.doc?.version,
                content: newContent,
              },
            });
          } catch {
            // non-blocking
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Batch replace failed for doc ${doc.id}: ${message}`);
        failedFileIds.push(doc.id);
      }
    }

    return {
      query,
      replaceWith,
      totalFilesAffected: affectedFileIds.length,
      totalOccurrencesReplaced,
      affectedFileIds,
      failedFileIds,
    };
  }
}
