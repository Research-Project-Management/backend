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

import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { ManuscriptNodeEntity } from '@/modules/manuscripts/structure/domain';
import { IntegrationsRepository } from '@/modules/integrations/integrations.repository';
import { ZoteroProvider } from '@/modules/integrations/providers/zotero.provider';
import { MendeleyProvider } from '@/modules/integrations/providers/mendeley.provider';
import { decryptToken } from '@/modules/integrations/utils/integration-crypto.utils';
import { LIBRARY_FACADE, ILibraryFacade } from '@/modules/library';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
} from '@/modules/manuscripts/core';

import {
  ICitationsAggregatorPort,
  ILibrarySyncPort,
  LibraryCollectionSummary,
  IBibtexParserPort,
  BibliographyFile,
  BibEntry,
  RegexAstBibtexParser,
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
    private readonly integrationsRepo?: IntegrationsRepository,
    @Optional()
    private readonly zoteroProvider?: ZoteroProvider,
    @Optional()
    private readonly mendeleyProvider?: MendeleyProvider,
    @Optional()
    @Inject(LIBRARY_FACADE)
    private readonly libraryFacade?: ILibraryFacade,
    @Optional()
    bibParser?: RegexAstBibtexParser,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    private readonly liveCollab?: LiveCollaborationPort,
  ) {
    this.bibParser = bibParser ?? new RegexAstBibtexParser();
  }

  // ─── Project .bib File Aggregation & Upsert ─────────────────────────────────

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

      for (const node of bibNodes) {
        if (!node.docId) continue;
        try {
          const doc = await this.docstoreService.getDoc(projectId, node.docId);
          const rawText = (doc.lines || []).join('\n');
          const entries = this.bibParser.parse(rawText);
          bibFiles.push(
            new BibliographyFile({
              path: node.path,
              entries,
            }),
          );
        } catch (err: unknown) {
          this.logger.warn(
            `Failed to read doc ${node.docId} for ${node.path}: ${(err as Error)?.message}`,
          );
        }
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
    return this.appendEntriesToBib(projectId, [entry], targetFilename);
  }

  public async appendEntriesToBib(
    projectId: string,
    entries: BibEntry[],
    targetFilename = 'references.bib',
  ): Promise<string> {
    const cleanFilename = targetFilename
      .replace(/^(\.\/)+/, '')
      .replace(/^\/+/, '');
    const cleanPath = `/${cleanFilename}`;

    if (
      entries.length === 0 ||
      !this.structureService ||
      !this.docstoreService
    ) {
      return cleanPath;
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
      let updatedText = currentText;
      for (const entry of entries) {
        updatedText = this.upsertEntryText(
          updatedText,
          entry.key.value,
          entry.toBibtexString(),
        );
      }

      if (updatedText === currentText) {
        return targetNode.path;
      }

      const nextLines = updatedText.split('\n');
      await this.docstoreService.updateDoc(projectId, docId, {
        lines: nextLines,
        version: (doc.version ?? 0) + 1,
        expectedRev: doc.rev,
      });

      await this.liveCollab
        ?.applyExternalText(projectId, docId, nextLines.join('\n'))
        .catch(() => {});

      return targetNode.path;
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

    const newNode = await this.structureService.createNode(projectId, {
      path: cleanPath,
      name: cleanFilename,
      type: 'DOC',
      docId: createdDoc._id,
      parentId: null,
    });

    return newNode.path;
  }

  // ─── Library Sync (Zotero, Mendeley, Flux Library) ──────────────────────────

  public async listCollections(
    userId: string,
  ): Promise<LibraryCollectionSummary[]> {
    const results: LibraryCollectionSummary[] = [];

    if (this.integrationsRepo && this.zoteroProvider) {
      try {
        const conn = await this.integrationsRepo.findConnection(
          userId,
          'zotero',
        );
        if (conn && conn.status === 'connected' && !conn.authFailedAt) {
          const decryptedToken = decryptToken(conn.accessToken);
          const zoteroCols = await this.zoteroProvider.fetchCollections(
            decryptedToken,
            conn.providerUserId,
          );
          for (const col of zoteroCols) {
            results.push({
              id: `zotero:${col.id}`,
              name: `[Zotero] ${col.name}`,
              itemCount: col.itemCount,
            });
          }
        }
      } catch (zoteroErr: unknown) {
        const msg =
          zoteroErr instanceof Error ? zoteroErr.message : String(zoteroErr);
        this.logger.warn(
          `Failed to fetch remote Zotero collections for user ${userId}: ${msg}`,
        );
      }
    }

    if (this.integrationsRepo && this.mendeleyProvider) {
      try {
        const conn = await this.integrationsRepo.findConnection(
          userId,
          'mendeley',
        );
        if (conn && conn.status === 'connected' && !conn.authFailedAt) {
          const decryptedToken = decryptToken(conn.accessToken);
          const mendeleyCols = await this.mendeleyProvider.fetchCollections(
            decryptedToken,
            conn.providerUserId,
          );
          for (const col of mendeleyCols) {
            results.push({
              id: `mendeley:${col.id}`,
              name: `[Mendeley] ${col.name}`,
              itemCount: col.itemCount,
            });
          }
        }
      } catch (mendeleyErr: unknown) {
        const msg =
          mendeleyErr instanceof Error
            ? mendeleyErr.message
            : String(mendeleyErr);
        this.logger.warn(
          `Failed to fetch remote Mendeley collections for user ${userId}: ${msg}`,
        );
      }
    }

    if (this.libraryFacade) {
      try {
        const collections = await this.libraryFacade.listCollections(userId);
        for (const c of collections || []) {
          results.push({
            id: c.id,
            name: c.name,
            itemCount: c._count?.collectionItems ?? c.itemCount ?? 0,
          });
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to list collections via LibraryFacade: ${(err as Error)?.message}`,
        );
      }
    }

    return results;
  }

  public async fetchCollectionBibtex(
    userId: string,
    collectionId: string,
  ): Promise<string> {
    if (
      collectionId.startsWith('zotero:') ||
      collectionId.startsWith('group:')
    ) {
      if (!this.integrationsRepo || !this.zoteroProvider) {
        throw new Error('Zotero integration services are not configured');
      }

      const conn = await this.integrationsRepo.findConnection(userId, 'zotero');
      if (!conn || conn.status !== 'connected' || conn.authFailedAt) {
        throw new Error(
          'Zotero account is not connected or authorization is invalid',
        );
      }

      const decryptedToken = decryptToken(conn.accessToken);
      const rawCollId = collectionId.startsWith('zotero:')
        ? collectionId.replace('zotero:', '')
        : collectionId;

      return await this.zoteroProvider.fetchCollectionBibtex(
        decryptedToken,
        conn.providerUserId,
        rawCollId,
      );
    }

    if (collectionId.startsWith('mendeley:')) {
      if (!this.integrationsRepo || !this.mendeleyProvider) {
        throw new Error('Mendeley integration services are not configured');
      }

      const conn = await this.integrationsRepo.findConnection(
        userId,
        'mendeley',
      );
      if (!conn || conn.status !== 'connected' || conn.authFailedAt) {
        throw new Error(
          'Mendeley account is not connected or authorization is invalid',
        );
      }

      const decryptedToken = decryptToken(conn.accessToken);
      const rawCollId = collectionId.replace('mendeley:', '');

      return await this.mendeleyProvider.fetchCollectionBibtex(
        decryptedToken,
        conn.providerUserId,
        rawCollId,
      );
    }

    if (this.libraryFacade) {
      try {
        const exportRes = await this.libraryFacade.exportLibrary(userId, {
          format: 'bibtex',
          collectionId,
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

    throw new Error(`Collection ${collectionId} not found`);
  }

  private upsertEntryText(
    text: string,
    key: string,
    bibString: string,
  ): string {
    return RegexAstBibtexParser.upsertEntry(text, key, bibString);
  }
}
