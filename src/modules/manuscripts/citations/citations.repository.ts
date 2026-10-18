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
import { PrismaService } from '@/core';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { ManuscriptNodeEntity } from '@/modules/manuscripts/structure/domain';
import { IntegrationsRepository } from '@/modules/integrations/integrations.repository';
import { ZoteroProvider } from '@/modules/integrations/providers/zotero.provider';
import { MendeleyProvider } from '@/modules/integrations/providers/mendeley.provider';
import { decryptToken } from '@/modules/integrations/utils/integration-crypto.utils';
import { LIBRARY_FACADE, ILibraryFacade } from '@/modules/library';

import {
  ICitationsAggregatorPort,
  ILibrarySyncPort,
  LibraryCollectionSummary,
  IIdentifierResolverPort,
  IBibtexParserPort,
  BibliographyFile,
  BibEntry,
  AcademicIdentifierVo,
  RegexAstBibtexParser,
  CrossrefArxivResolverAdapter,
  DbLibraryItem,
  formatLibraryItemToBibtex,
} from './domain';

@Injectable()
export class CitationsRepository
  implements
    ICitationsAggregatorPort,
    ILibrarySyncPort,
    IIdentifierResolverPort,
    IBibtexParserPort
{
  private readonly logger = new Logger(CitationsRepository.name);
  protected bibParser: IBibtexParserPort = new RegexAstBibtexParser();
  private readonly identifierResolver = new CrossrefArxivResolverAdapter();

  constructor(
    @Optional()
    private readonly structureService?: StructureService,
    @Optional()
    private readonly docstoreService?: DocstoreService,
    @Optional()
    private readonly prisma?: PrismaService,
    @Optional()
    private readonly integrationsRepo?: IntegrationsRepository,
    @Optional()
    private readonly zoteroProvider?: ZoteroProvider,
    @Optional()
    private readonly mendeleyProvider?: MendeleyProvider,
    @Optional()
    @Inject(LIBRARY_FACADE)
    private readonly libraryFacade?: ILibraryFacade,
  ) {}

  // ─── BibTeX Parser ──────────────────────────────────────────────────────────

  public parse(rawBibtex: string): BibEntry[] {
    return this.bibParser.parse(rawBibtex);
  }

  public format(entries: BibEntry[]): string {
    return this.bibParser.format(entries);
  }

  // ─── Identifier Resolution (DOI / arXiv) ────────────────────────────────────

  public async resolve(
    identifier: AcademicIdentifierVo,
  ): Promise<BibEntry | null> {
    return this.identifierResolver.resolve(identifier);
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
    const cleanFilename = targetFilename
      .replace(/^(\.\/)+/, '')
      .replace(/^\/+/, '');
    const cleanPath = `/${cleanFilename}`;

    if (!this.structureService || !this.docstoreService) {
      return cleanPath;
    }

    const nodes = await this.structureService.getAllNodes(projectId);
    const targetNode = nodes.find(
      (n: ManuscriptNodeEntity) =>
        n.path === cleanPath || n.name === cleanFilename,
    );

    const bibString = entry.toBibtexString();
    const entryLines = bibString.split('\n');

    if (targetNode && targetNode.docId) {
      const doc = await this.docstoreService.getDoc(
        projectId,
        targetNode.docId,
      );
      const currentLines = doc.lines || [];
      const currentText = currentLines.join('\n');
      const updatedText = this.upsertEntryText(
        currentText,
        entry.key.value,
        bibString,
      );

      if (updatedText === currentText) {
        return targetNode.path;
      }

      await this.docstoreService.updateDoc(projectId, targetNode.docId, {
        lines: updatedText.split('\n'),
        version: (doc.version ?? 0) + 1,
        expectedRev: doc.rev,
      });

      return targetNode.path;
    }

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

  public async saveBibFile(
    projectId: string,
    targetFilename: string,
    content: string,
  ): Promise<string> {
    const cleanFilename = targetFilename
      .replace(/^(\.\/)+/, '')
      .replace(/^\/+/, '');
    const cleanPath = `/${cleanFilename}`;

    if (!this.structureService || !this.docstoreService) {
      return cleanPath;
    }

    const nodes = await this.structureService.getAllNodes(projectId);
    const targetNode = nodes.find(
      (n: ManuscriptNodeEntity) =>
        n.path === cleanPath || n.name === cleanFilename,
    );
    const lines = content.split('\n');

    if (targetNode && targetNode.docId) {
      await this.docstoreService.updateDoc(projectId, targetNode.docId, {
        lines,
      });
      return targetNode.path;
    }

    const createdDoc = await this.docstoreService.createDoc(projectId, {
      path: cleanPath,
      lines,
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

  // ─── Library Sync (Zotero, Mendeley, Flux Library, Prisma) ──────────────────

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

    if (this.libraryFacade?.catalog) {
      try {
        const collections =
          await this.libraryFacade.catalog.listCollections(userId);
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
    } else if (this.prisma) {
      try {
        const collections = await this.prisma.collection.findMany({
          where: {
            userId,
            deletedAt: null,
          },
          select: {
            id: true,
            name: true,
            _count: {
              select: { collectionItems: true },
            },
          },
          orderBy: {
            sortOrder: 'asc',
          },
        });

        for (const c of collections) {
          results.push({
            id: c.id,
            name: c.name,
            itemCount: c._count.collectionItems,
          });
        }
      } catch (err) {
        this.logger.warn(
          `Failed to fetch collections from database for user ${userId}: ${(err as Error).message}`,
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

    if (this.libraryFacade?.citation) {
      try {
        const exportRes = await this.libraryFacade.citation.exportLibrary(
          userId,
          {
            format: 'bibtex',
            collectionId,
          },
        );
        if (exportRes?.content !== undefined) {
          return exportRes.content;
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to export collection BibTeX via LibraryFacade: ${(err as Error)?.message}`,
        );
      }
    }

    if (!this.prisma) {
      throw new Error(`Collection ${collectionId} not found`);
    }

    const collection = await this.prisma.collection.findFirst({
      where: { id: collectionId, userId, deletedAt: null },
      select: { id: true },
    });
    if (!collection) {
      throw new Error(`Collection ${collectionId} not found`);
    }

    const collectionItems = await this.prisma.collectionItem.findMany({
      where: {
        collectionId,
        item: { deletedAt: null },
      },
      include: {
        item: {
          include: {
            contributors: {
              orderBy: { orderIndex: 'asc' },
            },
          },
        },
      },
    });

    return collectionItems
      .map((ci) =>
        formatLibraryItemToBibtex(ci.item as unknown as DbLibraryItem),
      )
      .filter(Boolean)
      .join('\n\n');
  }

  private upsertEntryText(
    text: string,
    key: string,
    bibString: string,
  ): string {
    const targetKey = key.trim().toLowerCase();
    const ranges: Array<{ start: number; end: number }> = [];
    const entryStartRegex = /@([a-zA-Z]+)\s*\{\s*([^,\s]+)\s*,/g;

    let match: RegExpExecArray | null;
    while ((match = entryStartRegex.exec(text)) !== null) {
      const entryType = match[1].toLowerCase();
      if (
        entryType === 'comment' ||
        entryType === 'preamble' ||
        entryType === 'string'
      ) {
        continue;
      }
      const openIdx = match.index + match[0].indexOf('{');
      const closeIdx = this.findMatchingClosingBrace(text, openIdx);
      if (closeIdx === -1) break;

      if (match[2].trim().toLowerCase() === targetKey) {
        ranges.push({ start: match.index, end: closeIdx + 1 });
      }
      entryStartRegex.lastIndex = closeIdx + 1;
    }

    if (ranges.length === 0) {
      const trimmed = text.replace(/\s+$/, '');
      return trimmed ? `${trimmed}\n\n${bibString}\n` : `${bibString}\n`;
    }

    let result = '';
    let cursor = 0;
    ranges.forEach((r, idx) => {
      result += text.slice(cursor, r.start);
      if (idx === 0) {
        result += bibString;
        cursor = r.end;
      } else {
        const after = text.slice(r.end);
        const ws = after.match(/^\s*/)?.[0].length ?? 0;
        cursor = r.end + ws;
      }
    });
    result += text.slice(cursor);
    return result;
  }

  private findMatchingClosingBrace(text: string, openBraceIdx: number): number {
    let depth = 0;
    for (let i = openBraceIdx; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }
}

export class PluggableLibrarySyncAdapter extends CitationsRepository {
  constructor(
    prisma?: PrismaService,
    integrationsRepo?: IntegrationsRepository,
    zoteroProvider?: ZoteroProvider,
    mendeleyProvider?: MendeleyProvider,
    libraryFacade?: ILibraryFacade,
  ) {
    super(
      undefined,
      undefined,
      prisma,
      integrationsRepo,
      zoteroProvider,
      mendeleyProvider,
      libraryFacade,
    );
  }
}

export class ManuscriptBibAggregatorAdapter extends CitationsRepository {
  constructor(
    structureService?: StructureService,
    docstoreService?: DocstoreService,
    parser?: IBibtexParserPort,
  ) {
    super(structureService, docstoreService);
    if (parser) {
      this.bibParser = parser;
    }
  }
}
