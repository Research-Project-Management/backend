import {
  Injectable,
  Logger,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { CitationService } from '../citation/citation.service';
import { CatalogRepository } from '../catalog/catalog.repository';
import { ExportLibraryDto, ExportFormatType } from './dto/export.dto';

export interface ExportResult {
  format: ExportFormatType;
  filename: string;
  mimeType: string;
  content: string;
  itemCount: number;
}

@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly citationService: CitationService,
    @Optional() private readonly catalogRepo?: CatalogRepository,
  ) {}

  async exportLibrary(
    workspaceId: string,
    dto: ExportLibraryDto,
  ): Promise<ExportResult> {
    const items = await this.prisma.catalogItem.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(dto.itemIds && dto.itemIds.length > 0
          ? { id: { in: dto.itemIds } }
          : {}),
        ...(dto.collectionId
          ? { collectionItems: { some: { collectionId: dto.collectionId } } }
          : {}),
        ...(dto.tagId ? { itemTags: { some: { tagId: dto.tagId } } } : {}),
      },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Helper: derive author name list from contributors
    const getAuthorNames = (item: (typeof items)[0]) =>
      item.contributors
        .filter((c) => c.creatorType === 'author')
        .map(
          (c) =>
            c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
        );

    const timestamp = new Date().toISOString().split('T')[0];

    switch (dto.format) {
      case 'bibtex': {
        const entries = items.map((it) => {
          const authors = getAuthorNames(it);
          const res = this.citationService.formatItem(
            {
              id: it.id,
              itemType: it.itemType ?? 'journalArticle',
              title: it.title,
              authors,
              publicationTitle: it.publicationTitle ?? undefined,
              year: it.year ?? undefined,
              volume: it.volume ?? undefined,
              pages: it.pages ?? undefined,
              doi: it.doi ?? undefined,
              url: it.url ?? undefined,
              citationKey: it.citationKey ?? undefined,
            },
            'bibtex',
          );
          return res.bibliography;
        });

        return {
          format: 'bibtex',
          filename: `library-export-${timestamp}.bib`,
          mimeType: 'application/x-bibtex',
          content: entries.join('\n\n'),
          itemCount: items.length,
        };
      }

      case 'ris': {
        const entries = items.map((it) => {
          const authors = getAuthorNames(it);
          const res = this.citationService.formatItem(
            {
              id: it.id,
              itemType: it.itemType ?? 'journalArticle',
              title: it.title,
              authors,
              publicationTitle: it.publicationTitle ?? undefined,
              year: it.year ?? undefined,
              volume: it.volume ?? undefined,
              pages: it.pages ?? undefined,
              doi: it.doi ?? undefined,
              url: it.url ?? undefined,
            },
            'ris',
          );
          return res.bibliography;
        });

        return {
          format: 'ris',
          filename: `library-export-${timestamp}.ris`,
          mimeType: 'application/x-research-info-systems',
          content: entries.join('\n'),
          itemCount: items.length,
        };
      }

      case 'csl-json': {
        const cslList = items.map((it) => ({
          id: it.citationKey || it.id,
          type:
            it.itemType === 'conferencePaper'
              ? 'paper-conference'
              : 'article-journal',
          title: it.title,
          author: getAuthorNames(it).map((a) => {
            const parts = a.trim().split(/\s+/);
            const family = parts.pop() || '';
            const given = parts.join(' ');
            return { given, family };
          }),
          issued: it.year ? { 'date-parts': [[it.year]] } : undefined,
          'container-title': it.publicationTitle ?? undefined,
          volume: it.volume ?? undefined,
          page: it.pages ?? undefined,
          DOI: it.doi ?? undefined,
          URL: it.url ?? undefined,
        }));

        return {
          format: 'csl-json',
          filename: `library-export-${timestamp}.json`,
          mimeType: 'application/json',
          content: JSON.stringify(cslList, null, 2),
          itemCount: items.length,
        };
      }

      case 'csv': {
        const headers = [
          'id',
          'title',
          'authors',
          'year',
          'publicationTitle',
          'doi',
          'itemType',
        ];
        const rows = items.map((it) => [
          `"${it.id}"`,
          `"${(it.title || '').replace(/"/g, '""')}"`,
          `"${getAuthorNames(it).join('; ').replace(/"/g, '""')}"`,
          it.year || '',
          `"${(it.publicationTitle || '').replace(/"/g, '""')}"`,
          `"${it.doi || ''}"`,
          `"${it.itemType || ''}"`,
        ]);

        const csvContent = [
          headers.join(','),
          ...rows.map((r) => r.join(',')),
        ].join('\n');

        return {
          format: 'csv',
          filename: `library-export-${timestamp}.csv`,
          mimeType: 'text/csv',
          content: csvContent,
          itemCount: items.length,
        };
      }

      case 'markdown': {
        const mdLines = [`# Library Export (${timestamp})\n`];
        items.forEach((it, idx) => {
          const auth = getAuthorNames(it).join(', ') || 'Unknown Authors';
          const yr = it.year ? ` (${it.year})` : '';
          mdLines.push(`${idx + 1}. **${it.title}** â€” *${auth}*${yr}`);
          if (it.publicationTitle)
            mdLines.push(`   *Published in:* ${it.publicationTitle}`);
          if (it.doi)
            mdLines.push(`   *DOI:* [${it.doi}](https://doi.org/${it.doi})`);
          mdLines.push('');
        });

        return {
          format: 'markdown',
          filename: `library-export-${timestamp}.md`,
          mimeType: 'text/markdown',
          content: mdLines.join('\n'),
          itemCount: items.length,
        };
      }

      default:
        throw new BadRequestException(
          `Unsupported export format: ${(dto as { format: string }).format}`,
        );
    }
  }

  async exportBundle(workspaceId: string, collectionId: string) {
    const collection = await this.prisma.collection.findFirst({
      where: { id: collectionId, workspaceId, deletedAt: null },
    });

    if (!collection) {
      throw new BadRequestException(`Collection ${collectionId} not found`);
    }

    const items = await this.prisma.catalogItem.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        collectionItems: { some: { collectionId } },
      },
      include: {
        attachments: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const bibtexRes = await this.exportLibrary(workspaceId, {
      format: 'bibtex',
      collectionId,
    });

    const files: Array<{
      itemId: string;
      title: string;
      filename: string;
      fileUrl: string;
    }> = [];
    for (const it of items) {
      for (const att of it.attachments) {
        files.push({
          itemId: it.id,
          title: it.title,
          filename: att.filename,
          fileUrl: att.url,
        });
      }
    }

    return {
      collection: { id: collection.id, name: collection.name },
      totalItems: items.length,
      totalFiles: files.length,
      bibtex: bibtexRes.content,
      files,
    };
  }
}
