/**
 * citations/citations.repository.ts
 * Direct @Injectable() Repository for Manuscripts Citations & Bibliography.
 *
 * Encapsulates:
 * - Project .bib file discovery and upsert (via StructureService & DocstoreService)
 * - External & local library sync (Zotero, Mendeley, LibraryFacade, Prisma fallback)
 * - DOI / arXiv academic identifier resolution
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
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import {
  ManuscriptNodeEntity,
  NodePathVo,
} from '@/modules/manuscripts/structure/domain';
import { IntegrationsService } from '@/modules/integrations/integrations.service';
import { LIBRARY_FACADE, ILibraryFacade } from '@/modules/library';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  ManuscriptDomainEventBus,
} from '@/modules/manuscripts/core';

import {
  ICitationsAggregatorPort,
  ILibrarySyncPort,
  LibraryCollectionSummary,
  IBibtexParserPort,
  BibliographyFile,
  BibEntry,
  BibtexParser,
  refactorCitationKeyInBibTeX,
  refactorCitationKeyInLatex,
} from './domain';

@Injectable()
export class CitationsRepository
  implements ICitationsAggregatorPort, ILibrarySyncPort
{
  private readonly logger = new Logger(CitationsRepository.name);
  protected bibParser: IBibtexParserPort;
  private readonly liveCollab?: LiveCollaborationPort;
  private readonly domainEventBus?: ManuscriptDomainEventBus;

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
    liveCollabOrLegacy?: LiveCollaborationPort,
    @Optional()
    domainEventBusOrParser?: ManuscriptDomainEventBus | BibtexParser,
    @Optional()
    legacyLiveCollab?: LiveCollaborationPort,
    @Optional()
    legacyDomainEventBus?: ManuscriptDomainEventBus,
  ) {
    const isParser = (obj: unknown): obj is IBibtexParserPort =>
      Boolean(
        obj &&
          typeof (obj as IBibtexParserPort).parse === 'function' &&
          typeof (obj as IBibtexParserPort).format === 'function',
      );
    const isEventBus = (obj: unknown): obj is ManuscriptDomainEventBus =>
      Boolean(
        obj &&
          typeof (obj as ManuscriptDomainEventBus).publish === 'function',
      );
    const isLiveCollab = (obj: unknown): obj is LiveCollaborationPort =>
      Boolean(
        obj &&
          (typeof (obj as LiveCollaborationPort).flushDocs === 'function' ||
            typeof (obj as LiveCollaborationPort).applyExternalText ===
              'function'),
      );

    this.bibParser = isParser(bibParser)
      ? bibParser
      : isParser(domainEventBusOrParser)
        ? domainEventBusOrParser
        : new BibtexParser();

    this.liveCollab = isLiveCollab(liveCollabOrLegacy)
      ? liveCollabOrLegacy
      : isLiveCollab(legacyLiveCollab)
        ? legacyLiveCollab
        : undefined;

    this.domainEventBus = isEventBus(domainEventBusOrParser)
      ? domainEventBusOrParser
      : isEventBus(legacyDomainEventBus)
        ? legacyDomainEventBus
        : undefined;
  }

  // ─── Project .bib File Aggregation & Upsert ─────────────────────────────────

  private async notifyDocMutated(
    projectId: string,
    docId: string,
    lines: string[],
    version: number,
  ): Promise<void> {
    if (this.domainEventBus) {
      await this.domainEventBus.publish({
        type: 'manuscript.document.mutated',
        projectId,
        docId,
        lines,
        version,
        source: 'citations',
        occurredAt: Date.now(),
      });
    } else {
      await this.liveCollab
        ?.applyExternalText(projectId, docId, lines.join('\n'))
        .catch(() => {});
    }
  }

  public async collectBibFiles(projectId: string): Promise<BibliographyFile[]> {
    const bibFiles: BibliographyFile[] = [];
    if (!this.structureService || !this.docstoreService) {
      return bibFiles;
    }

    try {
      const nodes = await this.structureService.getAllNodes(projectId);
      const bibNodes = nodes.filter(
        (n: ManuscriptNodeEntity) =>
          n.isDoc() && n.name.toLowerCase().endsWith('.bib'),
      );

      const validBibNodes = bibNodes.filter(
        (node): node is ManuscriptNodeEntity & { docId: string } =>
          Boolean(node.docId),
      );

      // Read-your-writes consistency: flush active in-memory Yjs buffers for bib files before reading
      if (this.liveCollab && validBibNodes.length > 0) {
        const bibDocIds = validBibNodes.map((n) => n.docId);
        await this.liveCollab.flushDocs(projectId, bibDocIds).catch(() => []);
      }

      const results = await Promise.all(
        validBibNodes.map(async (node) => {
          try {
            const doc = await this.docstoreService!.getDoc(
              projectId,
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
        `Error scanning bib nodes for project ${projectId}: ${(err as Error)?.message}`,
      );
    }

    return bibFiles;
  }

  public async appendEntryToBib(
    projectId: string,
    entry: BibEntry,
    targetFilename = 'references.bib',
  ): Promise<string> {
    const res = await this.appendEntriesToBib(projectId, [entry], targetFilename);
    return res.filePath;
  }

  public async appendEntriesToBib(
    projectId: string,
    entries: BibEntry[],
    targetFilename = 'references.bib',
  ): Promise<{ filePath: string; docId?: string; conflicts: string[] }> {
    const cleanFilename = NodePathVo.toRelative(
      targetFilename.replace(/^(\.\/)+/, ''),
    );
    const cleanPath = `/${cleanFilename}`;
    const conflicts: string[] = [];

    if (
      entries.length === 0 ||
      !this.structureService ||
      !this.docstoreService
    ) {
      return { filePath: cleanPath, conflicts };
    }

    const nodes = await this.structureService.getAllNodes(projectId);
    const targetNode = nodes.find(
      (n: ManuscriptNodeEntity) =>
        n.path === cleanPath || n.name === cleanFilename,
    );

    if (targetNode && targetNode.docId) {
      const docId = targetNode.docId;
      await (
        this.liveCollab?.flushDoc?.(projectId, docId) ??
        this.liveCollab?.flushDocs?.(projectId, [docId])
      )?.catch(() => {});

      const doc = await this.docstoreService.getDoc(projectId, docId);
      const currentLines = doc.lines || [];
      const currentText = currentLines.join('\n');

      const entryKeyRegex = /@([a-zA-Z]+)\s*\{\s*([^,\s]+)\s*,/g;
      const existingKeys = new Set<string>();
      const maskedText =
        BibtexParser.maskCommentsPreserveLength(currentText);
      let m: RegExpExecArray | null;
      while ((m = entryKeyRegex.exec(maskedText)) !== null) {
        existingKeys.add(m[2].trim().toLowerCase());
      }

      let updatedText = currentText;
      for (const entry of entries) {
        const k = entry.key.value.trim().toLowerCase();
        if (existingKeys.has(k)) {
          conflicts.push(entry.key.value);
        }
        updatedText = this.upsertEntryText(
          updatedText,
          entry.key.value,
          entry.toBibtexString(),
        );
      }

      if (updatedText === currentText) {
        return { filePath: targetNode.path, docId, conflicts };
      }

      const nextLines = updatedText.split('\n');
      const nextVersion = (doc.version ?? 0) + 1;
      await this.docstoreService.updateDoc(projectId, docId, {
        lines: nextLines,
        version: nextVersion,
        expectedRev: doc.rev,
      });

      await this.notifyDocMutated(projectId, docId, nextLines, nextVersion);

      return { filePath: targetNode.path, docId, conflicts };
    }

    let initialText = '';
    for (const entry of entries) {
      initialText = this.upsertEntryText(
        initialText,
        entry.key.value,
        entry.toBibtexString(),
      );
    }
    const entryLines = initialText.replace(/\n$/, '').split('\n');

    const createdDoc = await this.docstoreService.createDoc(projectId, {
      path: cleanPath,
      lines: entryLines,
    });
    const createdDocId =
      (createdDoc as { _id?: string; id?: string })._id ||
      (createdDoc as { _id?: string; id?: string }).id;

    let newNode: ManuscriptNodeEntity;
    try {
      newNode = await this.structureService.createNode(projectId, {
        path: cleanPath,
        name: NodePathVo.basename(cleanPath) || cleanFilename,
        type: 'DOC',
        docId: createdDocId,
        parentId: null,
      });
    } catch (err) {
      if (createdDocId) {
        if (typeof this.docstoreService.deleteDoc === 'function') {
          await this.docstoreService
            .deleteDoc(projectId, createdDocId)
            .catch(() => undefined);
        } else if (typeof this.docstoreService.patchDoc === 'function') {
          await this.docstoreService
            .patchDoc(projectId, createdDocId, { deleted: true })
            .catch(() => undefined);
        }
      }
      throw err;
    }

    if (createdDocId) {
      await this.notifyDocMutated(
        projectId,
        createdDocId,
        entryLines,
        (createdDoc as { version?: number }).version ?? 1,
      );
    }

    return { filePath: newNode.path, docId: createdDocId, conflicts };
  }

  /**
   * Atomically refactors a citation key across all .bib and .tex/.md documents in the project.
   */
  public async refactorCitationKey(
    projectId: string,
    oldKey: string,
    newKey: string,
  ): Promise<{
    affectedFiles: Array<{
      docId: string;
      path: string;
      count: number;
      newContent: string;
    }>;
    totalReplacements: number;
  }> {
    const affectedFiles: Array<{
      docId: string;
      path: string;
      count: number;
      newContent: string;
    }> = [];
    let totalReplacements = 0;

    if (!this.docstoreService) {
      return { affectedFiles, totalReplacements };
    }

    const nodePathByDocId = new Map<string, string>();
    if (this.structureService) {
      try {
        const nodes = await this.structureService.getAllNodes(projectId);
        for (const n of nodes) {
          if (n.isDoc() && n.docId) {
            nodePathByDocId.set(n.docId, n.path || n.name);
          }
        }
      } catch {
        // Non-blocking fallback to doc.path
      }
    }

    if (this.liveCollab) {
      const collabWithFlushProject = this.liveCollab as LiveCollaborationPort & {
        flushProject?: (projectId: string) => Promise<void>;
      };
      if (typeof collabWithFlushProject.flushProject === 'function') {
        await collabWithFlushProject.flushProject(projectId).catch(() => {});
      } else if (
        typeof this.liveCollab.flushDocs === 'function' &&
        nodePathByDocId.size > 0
      ) {
        await this.liveCollab
          .flushDocs(projectId, Array.from(nodePathByDocId.keys()))
          .catch(() => []);
      }
    }

    const docs = await this.docstoreService.getAllDocs(projectId);
    const pendingMutations: Array<{
      docId: string;
      filePath: string;
      nextLines: string[];
      nextVersion: number;
      expectedRev: number | undefined;
      count: number;
      newContent: string;
    }> = [];

    for (const doc of docs) {
      const docId = doc._id;
      const filePath = nodePathByDocId.get(docId) || doc.path || 'main.tex';
      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const currentText = (doc.lines || []).join('\n');
      if (!currentText) continue;

      const refactorRes =
        ext === 'bib'
          ? refactorCitationKeyInBibTeX(currentText, oldKey, newKey)
          : refactorCitationKeyInLatex(currentText, oldKey, newKey);

      if (refactorRes.count > 0 && refactorRes.content !== currentText) {
        pendingMutations.push({
          docId,
          filePath,
          nextLines: refactorRes.content.split('\n'),
          nextVersion: (doc.version ?? 0) + 1,
          expectedRev: doc.rev,
          count: refactorRes.count,
          newContent: refactorRes.content,
        });
      }
    }

    const docstore = this.docstoreService;
    if (docstore) {
      await Promise.all(
        pendingMutations.map(async (m) => {
          await docstore.updateDoc(projectId, m.docId, {
            lines: m.nextLines,
            version: m.nextVersion,
            expectedRev: m.expectedRev,
          });
          await this.notifyDocMutated(
            projectId,
            m.docId,
            m.nextLines,
            m.nextVersion,
          );
        }),
      );
    }

    for (const m of pendingMutations) {
      totalReplacements += m.count;
      affectedFiles.push({
        docId: m.docId,
        path: m.filePath,
        count: m.count,
        newContent: m.newContent,
      });
    }

    return { affectedFiles, totalReplacements };
  }

  /**
   * Reads and optionally updates a single document's content in DocstoreService + Yjs.
   */
  public async getDocContent(
    projectId: string,
    docId: string,
  ): Promise<{ content: string; path: string } | null> {
    if (!this.docstoreService) return null;
    await (
      this.liveCollab?.flushDoc?.(projectId, docId) ??
      this.liveCollab?.flushDocs?.(projectId, [docId])
    )?.catch(() => {});

    try {
      const doc = await this.docstoreService.getDoc(projectId, docId);
      return {
        content: (doc.lines || []).join('\n'),
        path: doc.path || 'main.tex',
      };
    } catch {
      return null;
    }
  }

  public async updateDocContent(
    projectId: string,
    docId: string,
    nextContent: string,
  ): Promise<void> {
    if (!this.docstoreService) return;
    const doc = await this.docstoreService.getDoc(projectId, docId);
    const nextLines = nextContent.split('\n');
    const nextVersion = (doc.version ?? 0) + 1;

    await this.docstoreService.updateDoc(projectId, docId, {
      lines: nextLines,
      version: nextVersion,
      expectedRev: doc.rev,
    });

    await this.notifyDocMutated(projectId, docId, nextLines, nextVersion);
  }

  // ─── Library Sync (Zotero, Mendeley, Flux Library) ──────────────────────────

  public async listCollections(
    userId: string,
    projectId?: string,
  ): Promise<LibraryCollectionSummary[]> {
    const fetchExternal = async (
      provider: 'zotero' | 'mendeley',
      label: string,
    ): Promise<LibraryCollectionSummary[]> => {
      if (!this.integrationsService) return [];
      try {
        const cols = await this.integrationsService.listCollections(
          userId,
          provider,
        );
        return (cols || []).map((col) => ({
          id: `${provider}:${col.id}`,
          name: `[${label}] ${col.name}`,
          itemCount: col.itemCount,
        }));
      } catch (err: unknown) {
        if (!(err instanceof NotFoundException)) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Failed to fetch remote ${label} collections for user ${userId}: ${msg}`,
          );
        }
        return [];
      }
    };

    const fetchLocal = async (): Promise<LibraryCollectionSummary[]> => {
      if (!this.libraryFacade) return [];
      try {
        const collections = await this.libraryFacade.listCollections(
          userId,
          projectId,
        );
        return (collections || []).map((c) => ({
          id: c.id,
          name: c.name,
          itemCount: c._count?.collectionItems ?? c.itemCount ?? 0,
        }));
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to list collections via LibraryFacade: ${(err as Error)?.message}`,
        );
        return [];
      }
    };

    const [zoteroCols, mendeleyCols, localCols] = await Promise.all([
      fetchExternal('zotero', 'Zotero'),
      fetchExternal('mendeley', 'Mendeley'),
      fetchLocal(),
    ]);

    return [...zoteroCols, ...mendeleyCols, ...localCols];
  }

  public async fetchCollectionBibtex(
    userId: string,
    collectionId: string,
    projectId?: string,
  ): Promise<string> {
    if (
      collectionId.startsWith('zotero:') ||
      collectionId.startsWith('group:')
    ) {
      const rawCollId = collectionId.startsWith('zotero:')
        ? collectionId.replace('zotero:', '')
        : collectionId;

      if (!this.integrationsService) {
        throw new ServiceUnavailableException(
          'Zotero integration services are not configured',
        );
      }

      const res = await this.integrationsService.fetchRemoteCollectionBibtex(
        userId,
        'zotero',
        rawCollId,
      );
      return res.bibtex;
    }

    if (collectionId.startsWith('mendeley:')) {
      const rawCollId = collectionId.replace('mendeley:', '');

      if (!this.integrationsService) {
        throw new ServiceUnavailableException(
          'Mendeley integration services are not configured',
        );
      }

      const res = await this.integrationsService.fetchRemoteCollectionBibtex(
        userId,
        'mendeley',
        rawCollId,
      );
      return res.bibtex;
    }

    if (this.libraryFacade) {
      try {
        const exportRes = await this.libraryFacade.exportLibrary(userId, {
          format: 'bibtex',
          collectionId,
          projectId,
        });
        if (exportRes?.content !== undefined) {
          return exportRes.content;
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to export collection BibTeX via LibraryFacade: ${(err as Error)?.message}`,
        );
      }
    }

    throw new NotFoundException(`Collection ${collectionId} not found`);
  }

  private upsertEntryText(
    text: string,
    key: string,
    bibString: string,
  ): string {
    return BibtexParser.upsertEntry(text, key, bibString);
  }
}
