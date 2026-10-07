/**
 * citations/core/adapters/library/pluggable-library-sync.adapter.ts
 * Adapter implementing ILibrarySyncPort.
 * Provides bridge for Zotero (via official API v3) and Flux Library integration.
 */

import { Injectable, Optional, Logger, Inject } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import {
  ILibrarySyncPort,
  LibraryCollectionSummary,
} from '../../ports/library-sync.port';
import { IntegrationsRepository } from '@/modules/integrations/integrations.repository';
import { ZoteroProvider } from '@/modules/integrations/providers/zotero.provider';
import { MendeleyProvider } from '@/modules/integrations/providers/mendeley.provider';
import { decryptToken } from '@/modules/integrations/utils/integration-crypto.utils';
import { LIBRARY_FACADE, ILibraryFacade } from '@/modules/library';
import {
  escapeLatex,
  formatBibtexName,
  sanitizeCitationKey,
  toBibtexValue,
} from '../../domain/utils/bibtex-value.utils';

@Injectable()
export class PluggableLibrarySyncAdapter implements ILibrarySyncPort {
  private readonly logger = new Logger(PluggableLibrarySyncAdapter.name);

  constructor(
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

  public async listCollections(
    userId: string,
  ): Promise<LibraryCollectionSummary[]> {
    const results: LibraryCollectionSummary[] = [];

    // 1. If user has connected Zotero account, fetch live Zotero collections via official API v3
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

    // 2. If user has connected Mendeley account, fetch remote folders
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

    // 3. Fetch local Flux library collections via LibraryFacade (or fallback to DB)
    if (this.libraryFacade?.catalog) {
      try {
        const collections =
          await this.libraryFacade.catalog.listCollections(userId);
        for (const c of collections || []) {
          results.push({
            id: c.id,
            name: c.name,
            itemCount:
              (c as any)._count?.collectionItems ?? (c as any).itemCount ?? 0,
          });
        }
      } catch (err: any) {
        this.logger.warn(
          `Failed to list collections via LibraryFacade: ${err?.message}`,
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

    // No hard-coded sample collections: only real remote / local collections are listed.
    return results;
  }

  public async fetchCollectionBibtex(
    userId: string,
    collectionId: string,
  ): Promise<string> {
    // 1. Check if this is a Zotero collection (prefixed with "zotero:" or "group:")
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

    // 2. Check if this is a Mendeley collection (prefixed with "mendeley:")
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

    // 3. Local Flux collections via LibraryFacade (or fallback to DB)
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
      } catch (err: any) {
        this.logger.warn(
          `Failed to export collection BibTeX via LibraryFacade: ${err?.message}`,
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

    // Empty collection -> empty BibTeX stream (sync becomes a no-op).
    return collectionItems
      .map((ci) => this.formatItemToBibtex(ci.item as unknown as DbLibraryItem))
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * Serializes a Flux library item (Zotero-schema item types + metadata JSON)
   * into a BibTeX entry. All values are escaped through toBibtexValue().
   */
  private formatItemToBibtex(item: DbLibraryItem): string {
    const meta = collectMetadata(item.metadata);
    const get = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = meta[k.toLowerCase()];
        if (v !== undefined && v !== null && String(v).trim() !== '') {
          return String(v).trim();
        }
      }
      return undefined;
    };

    const itemType = item.itemType || 'journalArticle';
    const container = item.publicationTitle || get('publicationTitle');
    const fields: Array<[string, string | undefined]> = [];
    let bibType = 'misc';

    // --- Creators -------------------------------------------------------
    const contributors = [...(item.contributors || [])].sort(
      (a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0),
    );
    const SECONDARY_ROLES = new Set([
      'editor',
      'serieseditor',
      'translator',
      'bookauthor',
      'reviewedauthor',
      'contributor',
      'commenter',
    ]);
    const nameOf = (c: DbContributor) =>
      formatBibtexName({
        lastName: c.lastName || (c.fieldMode === 1 ? c.fullName : null),
        firstName: c.firstName,
        fieldMode: c.fieldMode,
      }) || (c.fullName ? escapeLatex(c.fullName.trim()) : '');
    const authors = contributors
      .filter(
        (c) => !SECONDARY_ROLES.has((c.creatorType || 'author').toLowerCase()),
      )
      .map(nameOf)
      .filter(Boolean)
      .join(' and ');
    const editors = contributors
      .filter((c) => (c.creatorType || '').toLowerCase() === 'editor')
      .map(nameOf)
      .filter(Boolean)
      .join(' and ');

    // --- Type-specific fields ------------------------------------------
    switch (itemType) {
      case 'journalArticle':
      case 'magazineArticle':
      case 'newspaperArticle':
        bibType = 'article';
        fields.push(['journal', container]);
        break;
      case 'conferencePaper':
        bibType = 'inproceedings';
        fields.push([
          'booktitle',
          get('proceedingsTitle') || container || get('conferenceName'),
        ]);
        fields.push(['publisher', get('publisher')]);
        fields.push(['address', get('place')]);
        break;
      case 'book':
        bibType = 'book';
        fields.push(['publisher', get('publisher')]);
        fields.push(['address', get('place')]);
        fields.push(['edition', get('edition')]);
        fields.push(['series', get('series')]);
        break;
      case 'bookSection':
        bibType = 'incollection';
        fields.push(['booktitle', get('bookTitle') || container]);
        fields.push(['publisher', get('publisher')]);
        fields.push(['address', get('place')]);
        fields.push(['edition', get('edition')]);
        fields.push(['series', get('series')]);
        break;
      case 'thesis': {
        const thesisType = get('thesisType', 'type') || '';
        bibType = /master|magister|\bm\.?\s?(?:sc|a|s|eng|phil)\b/i.test(
          thesisType,
        )
          ? 'mastersthesis'
          : 'phdthesis';
        fields.push(['school', get('university', 'institution', 'publisher')]);
        fields.push(['address', get('place')]);
        break;
      }
      case 'report':
        bibType = 'techreport';
        fields.push([
          'institution',
          get('institution', 'publisher') || container,
        ]);
        fields.push(['number', get('reportNumber', 'number')]);
        fields.push(['type', get('reportType')]);
        fields.push(['address', get('place')]);
        break;
      case 'preprint': {
        bibType = 'misc';
        const arxivId = extractArxivId(
          get('arxivId', 'archiveID', 'archiveId'),
          item.doi,
          item.url,
        );
        if (arxivId) {
          fields.push(['eprint', arxivId]);
          fields.push(['archiveprefix', 'arXiv']);
          fields.push(['primaryclass', get('primaryClass', 'primaryCategory')]);
        } else {
          fields.push(['howpublished', get('repository') || container]);
        }
        break;
      }
      case 'webpage':
      case 'blogPost':
      case 'forumPost':
        bibType = 'misc';
        fields.push(['howpublished', get('websiteTitle') || container]);
        break;
      default:
        bibType = 'misc';
        fields.push(['howpublished', container]);
        fields.push(['publisher', get('publisher')]);
        break;
    }

    // --- Common fields -------------------------------------------------
    const pages = get('pages');
    const accessDate = get('accessDate');
    const common: Array<[string, string | undefined]> = [
      ['volume', get('volume')],
      ['number', itemType === 'report' ? undefined : get('issue')],
      [
        'pages',
        pages ? pages.replace(/\s*[-\u2010-\u2015]+\s*/g, '--') : undefined,
      ],
      ['year', item.year != null ? String(item.year) : get('year')],
      ['issn', get('ISSN')],
      ['isbn', get('ISBN')],
      ['doi', item.doi || get('DOI')],
      ['url', item.url || get('url')],
      [
        'urldate',
        accessDate && /^\d{4}-\d{2}-\d{2}/.test(accessDate)
          ? accessDate.slice(0, 10)
          : undefined,
      ],
    ];

    const citeKey =
      sanitizeCitationKey(item.citationKey || '') ||
      `item_${item.id.replace(/-/g, '').substring(0, 8)}`;

    const lines: string[] = [];
    if (authors) lines.push(`  author = {${authors}}`);
    if (editors) lines.push(`  editor = {${editors}}`);
    const title = toBibtexValue(item.title, { field: 'title' });
    if (title) lines.push(`  title = {${title}}`);

    const seen = new Set<string>(['author', 'editor', 'title']);
    for (const [name, raw] of [...fields, ...common]) {
      if (seen.has(name)) continue;
      const value = toBibtexValue(raw, { field: name });
      if (!value) continue;
      seen.add(name);
      lines.push(`  ${name} = {${value}}`);
    }

    return `@${bibType}{${citeKey},\n${lines.join(',\n')}\n}`;
  }
}

interface DbContributor {
  orderIndex?: number | null;
  lastName?: string | null;
  firstName?: string | null;
  fullName?: string | null;
  fieldMode?: number | null;
  creatorType?: string | null;
}

interface DbLibraryItem {
  id: string;
  itemType?: string | null;
  citationKey?: string | null;
  title?: string | null;
  publicationTitle?: string | null;
  year?: number | string | null;
  doi?: string | null;
  url?: string | null;
  metadata?: unknown;
  contributors?: DbContributor[];
}

/**
 * Flattens item.metadata (and a nested `extraFields` object if present) into a
 * lower-cased key map so Zotero field names match regardless of casing (ISSN/issn).
 */
function collectMetadata(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const add = (obj: unknown) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v === null || v === undefined || typeof v === 'object') continue;
      const key = k.toLowerCase();
      if (!(key in out)) out[key] = v;
    }
  };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    add(raw);
    add((raw as Record<string, unknown>).extraFields);
  }
  return out;
}

/** Extracts a bare arXiv identifier from an archive ID, arXiv DOI or arxiv.org URL. */
function extractArxivId(
  archiveId?: string | null,
  doi?: string | null,
  url?: string | null,
): string | undefined {
  const fromArchive = archiveId?.match(/^(?:arxiv:)?\s*(\S+)$/i)?.[1];
  if (
    archiveId &&
    /arxiv/i.test(archiveId) &&
    fromArchive &&
    /\d/.test(fromArchive)
  ) {
    return fromArchive;
  }
  if (archiveId && /^\d{4}\.\d{4,5}(v\d+)?$/.test(archiveId)) return archiveId;
  const fromDoi = doi?.match(/10\.48550\/arxiv\.(.+)$/i)?.[1];
  if (fromDoi) return fromDoi;
  const fromUrl = url?.match(
    /arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?$/i,
  )?.[1];
  return fromUrl || undefined;
}
