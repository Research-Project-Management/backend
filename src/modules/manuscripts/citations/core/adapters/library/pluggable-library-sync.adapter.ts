/**
 * citations/core/adapters/library/pluggable-library-sync.adapter.ts
 * Adapter implementing ILibrarySyncPort.
 * Provides bridge for Zotero (via official API v3) and Flux Library integration.
 */

import { Injectable, Optional, Logger } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import {
  ILibrarySyncPort,
  LibraryCollectionSummary,
} from '../../ports/library-sync.port';
import { IntegrationsRepository } from '@/modules/integrations/integrations.repository';
import { ZoteroProvider } from '@/modules/integrations/providers/zotero.provider';
import { MendeleyProvider } from '@/modules/integrations/providers/mendeley.provider';
import { decryptToken } from '@/modules/integrations/utils/integration-crypto.utils';

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
  ) {}

  private readonly defaultCollections: LibraryCollectionSummary[] = [
    {
      id: 'coll-default',
      name: 'My Library (Zotero Sample)',
      itemCount: 2,
    },
    {
      id: 'coll-ai-papers',
      name: 'Artificial Intelligence & Deep Learning',
      itemCount: 1,
    },
  ];

  private readonly mockBibtexData = new Map<string, string>([
    [
      'coll-default',
      `@article{vaswani2017attention,
  title = {Attention is all you need},
  author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N and Kaiser, {\\L}ukasz and Polosukhin, Illia},
  journal = {Advances in neural information processing systems},
  volume = {30},
  year = {2017}
}

@book{goodfellow2016deep,
  title = {Deep Learning},
  author = {Goodfellow, Ian and Bengio, Yoshua and Courville, Aaron},
  publisher = {MIT Press},
  year = {2016}
}`,
    ],
    [
      'coll-ai-papers',
      `@inproceedings{he2016deep,
  title = {Deep residual learning for image recognition},
  author = {He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing and Sun, Jian},
  booktitle = {Proceedings of the IEEE conference on computer vision and pattern recognition},
  pages = {770--778},
  year = {2016}
}`,
    ],
  ]);

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

    // 3. Fetch local Flux library collections from database
    if (this.prisma) {
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

    if (results.length > 0) {
      return results;
    }

    return [...this.defaultCollections];
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

    // 3. Check local Flux database collections
    if (this.prisma) {
      try {
        const collectionItems = await this.prisma.collectionItem.findMany({
          where: {
            collectionId,
            collection: {
              userId,
              deletedAt: null,
            },
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

        if (collectionItems.length > 0) {
          const bibEntries = collectionItems
            .map((ci) => this.formatItemToBibtex(ci.item))
            .filter(Boolean);
          if (bibEntries.length > 0) {
            return bibEntries.join('\n\n');
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to query collection items for collection ${collectionId}: ${msg}`,
        );
      }
    }

    // 3. Fallback to mock data if present
    const data = this.mockBibtexData.get(collectionId);
    if (!data) {
      throw new Error(`Collection ${collectionId} not found`);
    }
    return data;
  }

  private formatItemToBibtex(item: {
    id: string;
    itemType?: string | null;
    citationKey?: string | null;
    title?: string | null;
    publicationTitle?: string | null;
    year?: number | string | null;
    doi?: string | null;
    url?: string | null;
    contributors?: Array<{
      orderIndex?: number;
      lastName?: string | null;
      firstName?: string | null;
    }>;
  }): string {
    const typeMap: Record<string, string> = {
      journalArticle: 'article',
      book: 'book',
      bookSection: 'incollection',
      conferencePaper: 'inproceedings',
      thesis: 'phdthesis',
      report: 'techreport',
      webpage: 'misc',
    };
    const bibType = typeMap[item.itemType || ''] || 'misc';
    const citeKey =
      item.citationKey || `item_${item.id.replace(/-/g, '').substring(0, 8)}`;
    const authors = (item.contributors || [])
      .map((c) => {
        if (c.lastName && c.firstName) return `${c.lastName}, ${c.firstName}`;
        return c.lastName || c.firstName || '';
      })
      .filter(Boolean)
      .join(' and ');

    const fields: string[] = [];
    if (item.title) fields.push(`  title = {${item.title}}`);
    if (authors) fields.push(`  author = {${authors}}`);
    if (item.publicationTitle)
      fields.push(`  journal = {${item.publicationTitle}}`);
    if (item.year) fields.push(`  year = {${item.year}}`);
    if (item.doi) fields.push(`  doi = {${item.doi}}`);
    if (item.url) fields.push(`  url = {${item.url}}`);

    return `@${bibType}{${citeKey},\n${fields.join(',\n')}\n}`;
  }
}
