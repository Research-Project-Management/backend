/**
 * citations/citations.repository.ts
 * Direct @Injectable() Repository for Manuscripts Citations & Bibliography.
 *
 * Encapsulates:
 * - Project .bib file discovery and upsert (via StructureService & DocstoreService)
 * - External & local library sync (Zotero, Mendeley, LibraryFacade)
 * - BibTeX AST parsing & formatting
 */

import {
  Injectable,
  Logger,
  Optional,
  Inject,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { StructureService } from '@/modules/pages/structure/structure.service';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { PageNodeEntity, NodePathVo } from '@/modules/pages/structure/domain';
import { IntegrationsService } from '@/modules/integrations/integrations.service';
import { LIBRARY_FACADE, ILibraryFacade } from '@/modules/library';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  PageDomainEventBus,
} from '@/modules/pages/core';
import { DistributedLockService } from '@/core';

import {
  ICitationsAggregatorPort,
  ILibrarySyncPort,
  IBibtexParserPort,
} from '../domain/citations.ports';
import { BibEntry, BibliographyFile } from '../domain/bib-entry.domain';
import { BibtexParser, ConflictPolicy } from '../domain/bibtex.domain';
import { LibrarySyncAdapter } from '../services/sync.service';

@Injectable()
export class CitationsRepository
  implements ICitationsAggregatorPort, ILibrarySyncPort
{
  private readonly logger = new Logger(CitationsRepository.name);
  protected bibParser: IBibtexParserPort;

  constructor(
    @Optional()
    private readonly structureService?: StructureService,
    @Optional()
    private readonly docstoreService?: DocstoreService,
    @Optional()
    private readonly integrationsService?: IntegrationsService,
    @Optional()
    @Inject(LIBRARY_FACADE)
    private readonly libraryFacade?: ILibraryFacade,
    @Optional()
    bibParser?: BibtexParser,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    private readonly liveCollab?: LiveCollaborationPort,
    @Optional()
    private readonly domainEventBus?: PageDomainEventBus,
    @Optional()
    private readonly lockService?: DistributedLockService,
    @Optional()
    private readonly librarySyncAdapter?: LibrarySyncAdapter,
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

  public async collectBibFiles(
    spaceId: string,
    pageId?: string,
  ): Promise<BibliographyFile[]> {
    const bibFiles: BibliographyFile[] = [];
    if (!this.structureService || !this.docstoreService) {
      return bibFiles;
    }

    try {
      const nodes = await this.structureService.getAllNodes(
        spaceId,
        undefined,
        pageId,
      );
      const bibNodes = nodes.filter(
        (n: PageNodeEntity) =>
          n.isDoc() && n.name.toLowerCase().endsWith('.bib'),
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
            const doc = await this.docstoreService!.getDoc(
              spaceId,
              node.docId,
            );
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

    const lockResource = `citation:bib:${spaceId}:${pageId ?? 'default'}:${cleanPath}`;
    const executeWrite = () =>
      this.appendEntriesWithOccRetry(
        spaceId,
        entries,
        cleanFilename,
        cleanPath,
        pageId,
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
    const status = (err as { status?: number; statusCode?: number }).status ??
      (err as { status?: number; statusCode?: number }).statusCode;
    if (status === 409) return true;
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
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
    const targetNode = nodes.find(
      (n: PageNodeEntity) => n.path === cleanPath || n.name === cleanFilename,
    );

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
          await this.docstoreService!
            .deleteDoc(spaceId, createdDocId)
            .catch(() => undefined);
        } else if (typeof this.docstoreService!.patchDoc === 'function') {
          await this.docstoreService!
            .patchDoc(spaceId, createdDocId, { deleted: true })
            .catch(() => undefined);
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

  // ─── Library Sync (Zotero, Mendeley, Flux Library) ──────────────────────────

  public async fetchCollectionBibtex(
    userId: string,
    collectionId: string,
    spaceId?: string,
  ): Promise<string> {
    if (this.librarySyncAdapter) {
      return this.librarySyncAdapter.fetchCollectionBibtex(
        userId,
        collectionId,
        spaceId,
      );
    }

    const fallbackAdapter = new LibrarySyncAdapter(
      this.integrationsService,
      this.libraryFacade,
    );
    return fallbackAdapter.fetchCollectionBibtex(userId, collectionId, spaceId);
  }

  private upsertEntryText(
    text: string,
    key: string,
    bibString: string,
  ): string {
    return BibtexParser.upsertEntry(text, key, bibString);
  }
}
