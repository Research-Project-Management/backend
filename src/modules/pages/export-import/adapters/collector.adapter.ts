/**
 * modules/pages/export-import/adapters/collector.adapter.ts
 *
 * GoF Adapter + Template Method + Virtual Proxy:
 * Collects virtual file tree nodes, docstore text lines, filestore binary streams,
 * and CLSI build artifacts (.bbl / output.pdf) into Virtual Proxy entries (`getData`),
 * then either streams them lazily (O(1) memory) or materializes them concurrently.
 */

import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { Readable } from 'node:stream';
import { mapWithConcurrency } from '@/core';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  WorkspaceCollectorService,
} from '@/modules/pages/core';
import { IPageArchiveAggregatorPort } from '../domain/archive.ports';
import { resolveExportProfile } from '../domain/archive.policy';
import type { ExportableFileEntry } from '../types/archive.types';
import { StructureService } from '@/modules/pages/structure/structure.service';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { FilestoreService } from '@/modules/pages/filestore/filestore.service';
import { ClsiService } from '@/modules/pages/clsi/clsi.service';
import type { PageNodeEntity } from '@/modules/pages/structure/domain';

const COLLECT_CONCURRENCY = 6;

interface VirtualEntryProxy {
  path: string;
  nodeId?: string;
  loadBuffer: () => Promise<Buffer>;
}

@Injectable()
export class PageArchiveAggregatorAdapter extends IPageArchiveAggregatorPort {
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
  ) {
    super();
  }

  /**
   * GoF Template Method: Resolves workspace nodes, flushes live Yjs state, applies polymorphic
   * `IExportProfileStrategy` filtering, and builds Virtual Proxy thunks (`loadBuffer`).
   */
  private async buildVirtualEntryProxies(
    projectId: string,
    includePdf: boolean,
    cleanArxiv: boolean,
    pageId?: string,
  ): Promise<VirtualEntryProxy[]> {
    const profile = resolveExportProfile({ cleanArxiv });
    const nodes = pageId
      ? await this.structureService.getAllNodes(projectId, undefined, pageId)
      : await this.structureService.getAllNodes(projectId);
    const nonFolderNodes = nodes.filter((n) => n.type !== 'FOLDER');

    await this.flushLiveWorkspace(projectId, nonFolderNodes);

    const proxies: VirtualEntryProxy[] = [];

    for (const node of nonFolderNodes) {
      const relPath = node.path.replace(/^\/+/, '');
      if (!profile.shouldIncludeEntry(relPath)) continue;

      if (node.type === 'DOC' && node.docId) {
        const docId = node.docId;
        proxies.push({
          path: relPath,
          nodeId: node.id,
          loadBuffer: async () => {
            const doc = await this.docstoreService.getDoc(projectId, docId);
            return Buffer.from((doc.lines || []).join('\n'), 'utf8');
          },
        });
      } else if (node.type === 'FILE' && node.fileId) {
        const fileId = node.fileId;
        proxies.push({
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

    if (profile.includeBblArtifact && this.clsiService) {
      const hasBbl = proxies.some((p) => p.path.toLowerCase().endsWith('.bbl'));
      if (!hasBbl) {
        const bblProxy = await this.resolveBblArtifactProxy(
          projectId,
          nodes,
          pageId,
        );
        if (bblProxy) proxies.push(bblProxy);
      }
    }

    if (profile.shouldIncludeCompiledPdf(includePdf) && this.clsiService) {
      const pdfBuffer = await this.clsiService
        .readAuxFileBuffer(projectId, 'output.pdf', pageId)
        .catch(() => null);
      if (pdfBuffer && pdfBuffer.length > 0) {
        proxies.push({
          path: 'output.pdf',
          loadBuffer: async () => pdfBuffer,
        });
      }
    }

    return proxies;
  }

  public async collectLazyProjectEntries(
    projectId: string,
    includePdf = false,
    cleanArxiv = false,
    pageId?: string,
  ): Promise<ExportableFileEntry[]> {
    const proxies = await this.buildVirtualEntryProxies(
      projectId,
      includePdf,
      cleanArxiv,
      pageId,
    );
    return proxies.map((proxy) => ({
      path: proxy.path,
      getData: proxy.loadBuffer,
    }));
  }

  public async collectProjectEntries(
    projectId: string,
    includePdf = false,
    cleanArxiv = false,
    pageId?: string,
  ): Promise<ExportableFileEntry[]> {
    const proxies = await this.buildVirtualEntryProxies(
      projectId,
      includePdf,
      cleanArxiv,
      pageId,
    );

    const materialized = await mapWithConcurrency<
      VirtualEntryProxy,
      ExportableFileEntry | null
    >(proxies, COLLECT_CONCURRENCY, async (proxy) => {
      try {
        const data = await proxy.loadBuffer();
        return { path: proxy.path, data };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to materialize entry ${proxy.nodeId ?? ''} (${proxy.path}): ${errMsg}`,
        );
        return null;
      }
    });

    return materialized.filter((entry): entry is ExportableFileEntry => entry !== null);
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

  private async resolveBblArtifactProxy(
    projectId: string,
    nodes: PageNodeEntity[],
    pageId?: string,
  ): Promise<VirtualEntryProxy | null> {
    if (!this.clsiService) return null;
    try {
      const rootNode = nodes.find((n) => n.isRootDoc);
      const rootRelPath = rootNode ? rootNode.path.replace(/^\/+/, '') : null;
      const targetBblPath = rootRelPath
        ? rootRelPath.replace(/\.[^/.]+$/, '') + '.bbl'
        : 'output.bbl';

      const bblBuffer =
        (await this.clsiService.readAuxFileBuffer(
          projectId,
          targetBblPath,
          pageId,
        )) ||
        (targetBblPath !== 'output.bbl'
          ? await this.clsiService.readAuxFileBuffer(
              projectId,
              'output.bbl',
              pageId,
            )
          : null);

      if (bblBuffer && bblBuffer.length > 0) {
        return {
          path: targetBblPath,
          loadBuffer: async () => bblBuffer,
        };
      }
    } catch {
      // No compiled .bbl artifact available
    }
    return null;
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
