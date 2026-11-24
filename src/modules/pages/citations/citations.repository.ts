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

import {
  ICitationsAggregatorPort,
  ILibrarySyncPort,
  IBibtexParserPort,
  BibliographyFile,
  BibEntry,
  BibtexParser,
} from './domain';

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
  ) {
    this.bibParser = bibParser ?? new BibtexParser();
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

  public async collectBibFiles(
    projectId: string,
    pageId?: string,
  ): Promise<BibliographyFile[]> {
    const bibFiles: BibliographyFile[] = [];
    if (!this.structureService || !this.docstoreService) {
      return bibFiles;
    }

    try {
      const nodes = await this.structureService.getAllNodes(
        projectId,
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

  public async appendEntriesToBib(
    projectId: string,
    entries: BibEntry[],
    targetFilename = 'references.bib',
    pageId?: string,
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

    const nodes = await this.structureService.getAllNodes(
      projectId,
      undefined,
      pageId,
    );
    const targetNode = nodes.find(
      (n: PageNodeEntity) => n.path === cleanPath || n.name === cleanFilename,
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
      const maskedText = BibtexParser.maskCommentsPreserveLength(currentText);
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
      ...(pageId ? { pageId } : {}),
    });
    const createdDocId =
      (createdDoc as { _id?: string; id?: string })._id ||
      (createdDoc as { _id?: string; id?: string }).id;

    let newNode: PageNodeEntity;
    try {
      newNode = await this.structureService.createNode(
        projectId,
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

  // ─── Library Sync (Zotero, Mendeley, Flux Library) ──────────────────────────

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
          spaceId: projectId,
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
