/**
 * citations/core/adapters/library/pluggable-library-sync.adapter.ts
 * Adapter implementing ILibrarySyncPort.
 * Provides future-ready bridge for Zotero / Flux Library integration.
 */

import { Injectable, Optional, Logger } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { ILibrarySyncPort, LibraryCollectionSummary } from '../../ports/library-sync.port';

@Injectable()
export class PluggableLibrarySyncAdapter implements ILibrarySyncPort {
  private readonly logger = new Logger(PluggableLibrarySyncAdapter.name);

  constructor(
    @Optional()
    private readonly prisma?: PrismaService,
  ) {}

  private readonly defaultCollections: LibraryCollectionSummary[] = [
    {
      id: 'coll-default',
      name: 'My Library (Zotero Parity)',
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

  public async listCollections(userId: string): Promise<LibraryCollectionSummary[]> {
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

        if (collections.length > 0) {
          return collections.map((c) => ({
            id: c.id,
            name: c.name,
            itemCount: c._count.collectionItems,
          }));
        }
      } catch (err) {
        this.logger.warn(
          `Failed to fetch collections from database for user ${userId}: ${(err as Error).message}`,
        );
      }
    }
    return [...this.defaultCollections];
  }

  public async fetchCollectionBibtex(
    userId: string,
    collectionId: string,
  ): Promise<string> {
    if (this.prisma) {
      try {
        const collectionItems = await (this.prisma as any).collectionItem.findMany({
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
            .map((ci: any) => this.formatItemToBibtex(ci.item))
            .filter(Boolean);
          if (bibEntries.length > 0) {
            return bibEntries.join('\n\n');
          }
        }
      } catch (err) {
        this.logger.warn(
          `Failed to query collection items for collection ${collectionId}: ${(err as Error).message}`,
        );
      }
    }

    const data = this.mockBibtexData.get(collectionId);
    if (!data) {
      throw new Error(`Collection ${collectionId} not found`);
    }
    return data;
  }

  private formatItemToBibtex(item: any): string {
    const typeMap: Record<string, string> = {
      journalArticle: 'article',
      book: 'book',
      bookSection: 'incollection',
      conferencePaper: 'inproceedings',
      thesis: 'phdthesis',
      report: 'techreport',
      webpage: 'misc',
    };
    const bibType = typeMap[item.itemType] || 'misc';
    const citeKey =
      item.citationKey || `item_${item.id.replace(/-/g, '').substring(0, 8)}`;
    const authors = (item.contributors || [])
      .map((c: any) => {
        if (c.lastName && c.firstName) return `${c.lastName}, ${c.firstName}`;
        return c.lastName || c.firstName || '';
      })
      .filter(Boolean)
      .join(' and ');

    const fields: string[] = [];
    if (item.title) fields.push(`  title = {${item.title}}`);
    if (authors) fields.push(`  author = {${authors}}`);
    if (item.publicationTitle) fields.push(`  journal = {${item.publicationTitle}}`);
    if (item.year) fields.push(`  year = {${item.year}}`);
    if (item.doi) fields.push(`  doi = {${item.doi}}`);
    if (item.url) fields.push(`  url = {${item.url}}`);

    return `@${bibType}{${citeKey},\n${fields.join(',\n')}\n}`;
  }
}
