/**
 * modules/manuscripts/docstore/services/search-replace.service.ts
 * Domain/Application service encapsulating project-wide full-text/regex search and batch replace
 * across manuscript documents with DocstoreService contentHash integrity and Yjs live sync.
 */

import {
  Inject,
  Injectable,
  Logger,
  Optional,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import { DocstoreService } from '../docstore.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  ManuscriptDomainEventBus,
  NOOP_LIVE_COLLABORATION,
} from '@/modules/manuscripts/core';
import { buildSearchRegex, replaceInText } from '../domain';

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

@Injectable()
export class ManuscriptSearchReplaceService {
  private readonly logger = new Logger(ManuscriptSearchReplaceService.name);
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    private readonly prisma: PrismaService,
    private readonly docstoreService: DocstoreService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollabOrLegacyRef?:
      | LiveCollaborationPort
      | { get?: (token: unknown, opts?: unknown) => LiveCollaborationPort | null }
      | unknown,
    @Optional() private readonly domainEventBus?: ManuscriptDomainEventBus,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    injectedLiveCollab?: LiveCollaborationPort,
  ) {
    let resolved: LiveCollaborationPort | null | undefined = injectedLiveCollab;
    if (!resolved || typeof resolved.applyExternalText !== 'function') {
      if (
        liveCollabOrLegacyRef &&
        typeof (liveCollabOrLegacyRef as LiveCollaborationPort)
          .applyExternalText === 'function'
      ) {
        resolved = liveCollabOrLegacyRef as LiveCollaborationPort;
      } else if (
        liveCollabOrLegacyRef &&
        typeof (
          liveCollabOrLegacyRef as {
            get?: (token: unknown, opts?: unknown) => LiveCollaborationPort | null;
          }
        ).get === 'function'
      ) {
        try {
          resolved = (
            liveCollabOrLegacyRef as {
              get: (token: unknown, opts?: unknown) => LiveCollaborationPort | null;
            }
          ).get(LiveCollaborationPort, { strict: false });
        } catch {
          resolved = null;
        }
      }
    }
    this.liveCollab =
      resolved && typeof resolved.applyExternalText === 'function'
        ? resolved
        : NOOP_LIVE_COLLABORATION;
  }

  private getLiveCollaboration(): LiveCollaborationPort {
    return this.liveCollab;
  }

  private async syncLiveDoc(
    projectId: string,
    docId: string,
    lines: string[],
  ): Promise<boolean> {
    const live = this.getLiveCollaboration();
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

  private async getHydratedDocLines(
    projectId: string,
    doc: { id: string; lines: unknown; inStorage?: boolean },
  ): Promise<string[]> {
    if (doc.inStorage) {
      try {
        const hydrated = await this.docstoreService.getDoc(projectId, doc.id);
        if (Array.isArray(hydrated.lines)) {
          return hydrated.lines;
        }
      } catch {
        // Fallback to raw lines if hydration fails
      }
    }
    if (Array.isArray(doc.lines)) {
      return doc.lines as string[];
    }
    if (typeof doc.lines === 'string') {
      return doc.lines.split('\n');
    }
    return [];
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

    let re: RegExp;
    try {
      re = buildSearchRegex(query, {
        caseSensitive: body?.caseSensitive,
        wholeWord: body?.wholeWord,
        useRegex: body?.useRegex,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Invalid search pattern: ${message}`);
    }

    try {
      const where: Prisma.ManuscriptDocWhereInput = {
        projectId,
        deleted: false,
      };
      if (Array.isArray(body?.fileIds) && body.fileIds.length > 0) {
        where.id = { in: body.fileIds.filter((id) => isUuid(id)) };
      }

      // Read-your-writes consistency: flush pending in-memory Yjs edits to Postgres before searching
      const targetDocIds =
        Array.isArray(body?.fileIds) && body.fileIds.length > 0
          ? body.fileIds.filter((id) => isUuid(id))
          : [];
      const live = this.getLiveCollaboration();
      if (live) {
        await live.flushDocs(projectId, targetDocIds).catch(() => []);
      }

      const [docs, rootNodes] = await Promise.all([
        this.prisma.manuscriptDoc.findMany({
          where,
          select: { id: true, path: true, lines: true, inStorage: true },
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
        const lines = await this.getHydratedDocLines(projectId, doc);
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
      await this.prisma.manuscriptDoc.findMany({
        where,
        select: { id: true },
        take: 1000,
      })
    ).map((d) => d.id);
    const live = this.getLiveCollaboration();
    if (live && candidateIds.length > 0) {
      await live.flushDocs(projectId, candidateIds);
    }

    const docs = await this.prisma.manuscriptDoc.findMany({
      where: { id: { in: candidateIds } },
      select: { id: true, lines: true, version: true, rev: true, inStorage: true },
      take: 1000,
    });

    let totalOccurrencesReplaced = 0;
    const affectedFileIds: string[] = [];
    const failedFileIds: string[] = [];

    for (const doc of docs) {
      const docLines = await this.getHydratedDocLines(projectId, doc);
      const rawContent = docLines.join('\n');
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
          expectedRev: doc.rev,
        });
        if (this.domainEventBus) {
          await this.domainEventBus.publish({
            type: 'manuscript.document.mutated',
            projectId,
            docId: doc.id,
            lines,
            version: result.doc?.version ?? doc.version + 1,
            source: 'search-replace',
            occurredAt: Date.now(),
          });
        } else {
          await this.syncLiveDoc(projectId, doc.id, lines);
        }
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
