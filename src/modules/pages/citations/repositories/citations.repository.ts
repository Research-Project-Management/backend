/**
 * citations/citations.repository.ts
 * Direct @Injectable() Repository for Pages Citations & Bibliography.
 *
 * Encapsulates:
 * - Page-scoped .bib file discovery and upsert (via StructureService & DocstoreService)
 * - BibTeX AST parsing & formatting
 */

import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { DistributedLockService } from '@/core';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NodePathVo,
  PageDomainEventBus,
} from '@/modules/pages/core';
import { DocstoreService } from '@/modules/pages/docstore';
import { PageNodeEntity, StructureService } from '@/modules/pages/structure';

import { BibEntry, BibliographyFile } from '../domain/bib-entry.domain';
import { BibtexParser, ConflictPolicy } from '../domain/bibtex.domain';

@Injectable()
export class CitationsRepository {
  private readonly logger = new Logger(CitationsRepository.name);
  protected bibParser: BibtexParser;

  constructor(
    @Optional()
    private readonly structureService?: StructureService,
    @Optional()
    private readonly docstoreService?: DocstoreService,
    @Optional()
    bibParser?: BibtexParser,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    private readonly liveCollab?: LiveCollaborationPort,
    @Optional()
    private readonly domainEventBus?: PageDomainEventBus,
    @Optional()
    private readonly lockService?: DistributedLockService,
  ) {
    this.bibParser = bibParser ?? new BibtexParser();
  }

  // ─── Project .bib File Aggregation & Upsert ─────────────────────────────────

  private async notifyDocMutated(
    spaceId: string,
    docId: string,
    lines: string[],
    version: number,
  ): Promise<void> {
    if (this.domainEventBus) {
      await this.domainEventBus.publish({
        type: 'manuscript.document.mutated',
        projectId: spaceId,
        docId,
        lines,
        version,
        source: 'citations',
        occurredAt: Date.now(),
      });
    } else {
      await this.liveCollab
        ?.applyExternalText(spaceId, docId, lines.join('\n'))
        .catch(() => {});
    }
  }

  private static isDocNode(node: Partial<PageNodeEntity>): boolean {
    return typeof node.isDoc === 'function'
      ? node.isDoc()
      : node.type !== 'FOLDER' && node.type !== 'FILE';
  }

  public async collectBibFiles(
    spaceId: string,
    pageId?: string,
  ): Promise<BibliographyFile[]> {
    const bibFiles: BibliographyFile[] = [];
    if (!this.structureService || !this.docstoreService) {
      return bibFiles;
    }

    const scopedPageId = pageId?.trim() || undefined;

    try {
      const nodes = await this.structureService.getAllNodes(
        spaceId,
        undefined,
        scopedPageId,
      );
      const bibNodes = nodes.filter(
        (n: PageNodeEntity) =>
          CitationsRepository.isDocNode(n) &&
          n.name.toLowerCase().endsWith('.bib') &&
          (!scopedPageId || !n.pageId || n.pageId === scopedPageId),
      );

      const validBibNodes = bibNodes.filter(
        (node): node is PageNodeEntity & { docId: string } =>
          Boolean(node.docId),
      );

      // Read-your-writes consistency: flush active in-memory Yjs buffers for bib files before reading
      if (this.liveCollab && validBibNodes.length > 0) {
        const bibDocIds = validBibNodes.map((n) => n.docId);
        await this.liveCollab.flushDocs(spaceId, bibDocIds).catch(() => []);
      }

      const results = await Promise.all(
        validBibNodes.map(async (node) => {
          try {
            const doc = await this.docstoreService!.getDoc(spaceId, node.docId);
            const rawText = (doc.lines || []).join('\n');
            const entries = this.bibParser.parse(rawText);
            return new BibliographyFile({
              path: node.path,
              entries,
            });
          } catch (err: unknown) {
            this.logger.warn(
              `Failed to read doc ${node.docId} for ${node.path}: ${(err as Error)?.message}`,
            );
            return null;
          }
        }),
      );

      for (const file of results) {
        if (file) bibFiles.push(file);
      }
    } catch (err: unknown) {
      this.logger.error(
        `Error scanning bib nodes for project ${spaceId}: ${(err as Error)?.message}`,
      );
    }

    return bibFiles;
  }

  public async appendEntriesToBib(
    spaceId: string,
    entries: BibEntry[],
    targetFilename = 'references.bib',
    pageId?: string,
    conflictPolicy: ConflictPolicy = 'overwrite',
  ): Promise<{ filePath: string; docId?: string; conflicts: string[] }> {
    const scopedPageId = pageId?.trim() || undefined;
    const cleanFilename = NodePathVo.toRelative(
      targetFilename.replace(/^(\.\/)+/, ''),
    );
    const cleanPath = `/${cleanFilename}`;

    if (
      entries.length === 0 ||
      !this.structureService ||
      !this.docstoreService
    ) {
      return { filePath: cleanPath, conflicts: [] };
    }

    const lockResource = `citation:bib:${spaceId}:${scopedPageId ?? 'default'}:${cleanPath}`;
    const executeWrite = () =>
      this.appendEntriesWithOccRetry(
        spaceId,
        entries,
        cleanFilename,
        cleanPath,
        scopedPageId,
        conflictPolicy,
      );

    if (!this.lockService) {
      return executeWrite();
    }

    const maxLockAttempts = 4;
    for (let attempt = 0; attempt < maxLockAttempts; attempt++) {
      const lockedResult = await this.lockService.withLock(
        lockResource,
        10_000,
        () => executeWrite(),
      );
      if (lockedResult !== null) {
        return lockedResult;
      }
      if (attempt < maxLockAttempts - 1) {
        const delayMs = 80 * (attempt + 1) + Math.floor(Math.random() * 60);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    // Fallback to OCC retry if lock remained contested
    return executeWrite();
  }

  private isConflictError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const status =
      (err as { status?: number; statusCode?: number }).status ??
      (err as { status?: number; statusCode?: number }).statusCode;
    if (status === 409) return true;
    const msg = (
      err instanceof Error ? err.message : String(err)
    ).toLowerCase();
    return (
      msg.includes('conflict') ||
      msg.includes('revision') ||
      msg.includes('expectedrev') ||
      msg.includes('already exists') ||
      msg.includes('unique constraint')
    );
  }

  private async appendEntriesWithOccRetry(
    spaceId: string,
    entries: BibEntry[],
    cleanFilename: string,
    cleanPath: string,
    pageId?: string,
    conflictPolicy: ConflictPolicy = 'overwrite',
  ): Promise<{ filePath: string; docId?: string; conflicts: string[] }> {
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.appendEntriesOnce(
          spaceId,
          entries,
          cleanFilename,
          cleanPath,
          pageId,
          conflictPolicy,
        );
      } catch (err: unknown) {
        lastError = err;
        if (this.isConflictError(err) && attempt < maxAttempts - 1) {
          const backoffMs =
            50 * Math.pow(2, attempt) + Math.floor(Math.random() * 50);
          this.logger.warn(
            `OCC/create conflict on ${cleanPath} (attempt ${attempt + 1}/${maxAttempts}), retrying in ${backoffMs}ms`,
          );
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        throw err;
      }
    }

    throw lastError;
  }

  private async appendEntriesOnce(
    spaceId: string,
    entries: BibEntry[],
    cleanFilename: string,
    cleanPath: string,
    pageId?: string,
    conflictPolicy: ConflictPolicy = 'overwrite',
  ): Promise<{ filePath: string; docId?: string; conflicts: string[] }> {
    const conflicts: string[] = [];

    const nodes = await this.structureService!.getAllNodes(
      spaceId,
      undefined,
      pageId,
    );
    const scopedDocNodes = nodes.filter(
      (n: PageNodeEntity) =>
        CitationsRepository.isDocNode(n) &&
        (!pageId || !n.pageId || n.pageId === pageId),
    );
    const targetNode =
      scopedDocNodes.find((n) => n.path === cleanPath) ??
      (!cleanFilename.includes('/')
        ? scopedDocNodes.find((n) => n.name === cleanFilename)
        : undefined);

    if (targetNode && targetNode.docId) {
      const docId = targetNode.docId;
      await (
        this.liveCollab?.flushDoc?.(spaceId, docId) ??
        this.liveCollab?.flushDocs?.(spaceId, [docId])
      )?.catch(() => {});

      const doc = await this.docstoreService!.getDoc(spaceId, docId);
      const currentLines = doc.lines || [];
      const currentText = currentLines.join('\n');

      const { text: updatedText, conflicts: batchConflicts } =
        BibtexParser.upsertEntriesBatch(
          currentText,
          entries.map((entry) => ({
            key: entry.key.value,
            bibString: entry.toBibtexString(),
          })),
          conflictPolicy,
        );
      conflicts.push(...batchConflicts);

      if (updatedText === currentText) {
        return { filePath: targetNode.path, docId, conflicts };
      }

      const nextLines = updatedText.split('\n');
      const nextVersion = (doc.version ?? 0) + 1;
      await this.docstoreService!.updateDoc(spaceId, docId, {
        lines: nextLines,
        version: nextVersion,
        expectedRev: doc.rev,
      });

      await this.notifyDocMutated(spaceId, docId, nextLines, nextVersion);

      return { filePath: targetNode.path, docId, conflicts };
    }

    const { text: initialText } = BibtexParser.upsertEntriesBatch(
      '',
      entries.map((entry) => ({
        key: entry.key.value,
        bibString: entry.toBibtexString(),
      })),
    );
    const entryLines = initialText.replace(/\n$/, '').split('\n');

    const createdDoc = await this.docstoreService!.createDoc(spaceId, {
      path: cleanPath,
      lines: entryLines,
      ...(pageId ? { pageId } : {}),
    });
    const createdDocId =
      (createdDoc as { _id?: string; id?: string })._id ||
      (createdDoc as { _id?: string; id?: string }).id;

    let newNode: PageNodeEntity;
    try {
      newNode = await this.structureService!.createNode(
        spaceId,
        {
          path: cleanPath,
          name: NodePathVo.basename(cleanPath) || cleanFilename,
          type: 'DOC',
          docId: createdDocId,
          parentId: null,
          ...(pageId ? { pageId } : {}),
        },
        pageId,
      );
    } catch (err) {
      if (createdDocId) {
        if (typeof this.docstoreService!.deleteDoc === 'function') {
          await this.docstoreService!.deleteDoc(spaceId, createdDocId).catch(
            () => undefined,
          );
        } else if (typeof this.docstoreService!.patchDoc === 'function') {
          await this.docstoreService!.patchDoc(spaceId, createdDocId, {
            deleted: true,
          }).catch(() => undefined);
        }
      }
      throw err;
    }

    if (createdDocId) {
      await this.notifyDocMutated(
        spaceId,
        createdDocId,
        entryLines,
        (createdDoc as { version?: number }).version ?? 1,
      );
    }

    return { filePath: newNode.path, docId: createdDocId, conflicts };
  }
}
