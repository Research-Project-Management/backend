import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { Readable } from 'node:stream';
import { mapWithConcurrency } from '@/core';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
} from '@/modules/pages/core/ports/live-collaboration.port';
import { WorkspaceCollectorService } from '@/modules/pages/core/services/workspace-collector.service';
import { resolveExportProfile } from '../domain/archive.policy';
import type {
  ExportableFileEntry,
  RawZipEntryInput,
} from '../types/archive.types';
import { StructureService } from '@/modules/pages/structure/structure.service';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { FilestoreService } from '@/modules/pages/filestore/filestore.service';
import { ClsiService } from '@/modules/pages/clsi/clsi.service';
import type { PageNodeEntity } from '@/modules/pages/structure/domain';

const COLLECT_CONCURRENCY = 6;

interface DeferredEntry {
  path: string;
  nodeId?: string;
  loadBuffer: () => Promise<Buffer | null>;
}

@Injectable()
export class PageArchiveAggregatorAdapter {
  private readonly logger = new Logger(PageArchiveAggregatorAdapter.name);

  constructor(
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    private readonly filestoreService: FilestoreService,
    @Optional() private readonly clsiService?: ClsiService,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    private readonly liveCollab?: LiveCollaborationPort,
    @Optional()
    private readonly workspaceCollector?: WorkspaceCollectorService,
  ) {}

  private async resolveDeferredEntries(
    projectId: string,
    includePdf: boolean,
    cleanArxiv: boolean,
    pageId?: string,
  ): Promise<DeferredEntry[]> {
    const profile = resolveExportProfile({ cleanArxiv, includePdf });
    const nodes = pageId
      ? await this.structureService.getAllNodes(projectId, undefined, pageId)
      : await this.structureService.getAllNodes(projectId);
    const nonFolderNodes = nodes.filter((n) => n.type !== 'FOLDER');

    // Flush active CRDT edits BEFORE batch-prefetching Postgres docs so exports never serve stale content
    await this.flushLiveWorkspace(projectId, nonFolderNodes);
    const prefetchedDocsById = await this.batchPrefetchDocs(projectId, pageId);

    const entries: DeferredEntry[] = [];

    for (let i = 0; i < nonFolderNodes.length; i++) {
      const node = nonFolderNodes[i];
      const relPath = node.path.replace(/^\/+/, '');
      if (!profile.shouldInclude(relPath)) continue;

      if (node.type === 'DOC' && node.docId) {
        const docId = node.docId;
        entries.push({
          path: relPath,
          nodeId: node.id,
          loadBuffer: async () => {
            const prefetchedLines = prefetchedDocsById?.get(docId);
            if (prefetchedLines !== undefined) {
              return Buffer.from(prefetchedLines.join('\n'), 'utf8');
            }
            const doc = await this.docstoreService.getDoc(projectId, docId);
            return Buffer.from((doc.lines || []).join('\n'), 'utf8');
          },
        });
      } else if (node.type === 'FILE' && node.fileId) {
        const fileId = node.fileId;
        entries.push({
          path: relPath,
          nodeId: node.id,
          loadBuffer: async () => {
            const streamResult = await this.filestoreService.openReadStream(
              projectId,
              fileId,
            );
            return this.streamToBuffer(streamResult.stream);
          },
        });
      }
    }

    if (profile.includeBbl && this.clsiService) {
      const hasBbl = entries.some((e) => e.path.toLowerCase().endsWith('.bbl'));
      if (!hasBbl) {
        entries.push(this.createDeferredBblEntry(projectId, nodes, pageId));
      }
    }

    if (profile.includePdf && this.clsiService) {
      const clsi = this.clsiService;
      entries.push({
        path: 'output.pdf',
        loadBuffer: async () => {
          const buf = await clsi
            .readAuxFileBuffer(projectId, 'output.pdf', pageId)
            .catch(() => null);
          return buf && buf.length > 0 ? buf : null;
        },
      });
    }

    return entries;
  }

  public async collectLazyProjectEntries(
    projectId: string,
    includePdf = false,
    cleanArxiv = false,
    pageId?: string,
  ): Promise<RawZipEntryInput[]> {
    const deferred = await this.resolveDeferredEntries(
      projectId,
      includePdf,
      cleanArxiv,
      pageId,
    );
    return deferred.map((item) => ({
      path: item.path,
      getData: item.loadBuffer,
    }));
  }

  public async collectProjectEntries(
    projectId: string,
    includePdf = false,
    cleanArxiv = false,
    pageId?: string,
  ): Promise<ExportableFileEntry[]> {
    const deferred = await this.resolveDeferredEntries(
      projectId,
      includePdf,
      cleanArxiv,
      pageId,
    );

    const materialized = await mapWithConcurrency<
      DeferredEntry,
      ExportableFileEntry | null
    >(deferred, COLLECT_CONCURRENCY, async (item) => {
      try {
        const data = await item.loadBuffer();
        if (data === null) return null;
        return { path: item.path, data };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to collect entry ${item.nodeId ?? ''} (${item.path}): ${errMsg}`,
        );
        return null;
      }
    });

    return materialized.filter((e): e is ExportableFileEntry => e !== null);
  }

  /**
   * Batch O(1)-query prefetch of all project documents to eliminate N+1 `getDoc` SQL queries.
   */
  private async batchPrefetchDocs(
    projectId: string,
    pageId?: string,
  ): Promise<Map<string, string[]> | null> {
    if (typeof this.docstoreService.getAllDocs !== 'function') {
      return null;
    }
    try {
      const allDocs = await this.docstoreService.getAllDocs(projectId, pageId);
      if (!Array.isArray(allDocs) || allDocs.length === 0) return null;
      const map = new Map<string, string[]>();
      for (let i = 0; i < allDocs.length; i++) {
        const doc = allDocs[i];
        const id = doc._id || doc.id;
        if (id) map.set(id, doc.lines || []);
      }
      return map;
    } catch {
      return null;
    }
  }

  private async flushLiveWorkspace(
    projectId: string,
    nonFolderNodes: PageNodeEntity[],
  ): Promise<void> {
    try {
      const docIds = nonFolderNodes
        .filter((n) => n.docId)
        .map((n) => n.docId as string);
      if (this.workspaceCollector) {
        await this.workspaceCollector.flushProjectWorkspace(projectId, docIds);
      } else if (this.liveCollab && docIds.length > 0) {
        await this.liveCollab.flushDocs(projectId, docIds);
      }
    } catch {
      // Non-blocking flush fallback
    }
  }

  private createDeferredBblEntry(
    projectId: string,
    nodes: PageNodeEntity[],
    pageId?: string,
  ): DeferredEntry {
    const rootNode = nodes.find((n) => n.isRootDoc);
    const rootRelPath = rootNode ? rootNode.path.replace(/^\/+/, '') : null;
    const targetBblPath = rootRelPath
      ? rootRelPath.replace(/\.[^/.]+$/, '') + '.bbl'
      : 'output.bbl';
    const clsi = this.clsiService;

    return {
      path: targetBblPath,
      loadBuffer: async () => {
        if (!clsi) return null;
        try {
          const bblBuffer =
            (await clsi.readAuxFileBuffer(projectId, targetBblPath, pageId)) ||
            (targetBblPath !== 'output.bbl'
              ? await clsi.readAuxFileBuffer(projectId, 'output.bbl', pageId)
              : null);
          return bblBuffer && bblBuffer.length > 0 ? bblBuffer : null;
        } catch {
          return null;
        }
      },
    };
  }

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk) =>
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      );
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', (err) => reject(err));
    });
  }
}
