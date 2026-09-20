import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../../../../core/database/prisma.service';
import { QueryRepository } from '../../../infrastructure/repositories/query.repository';
import { ItemsService } from '../../services/items.service';
import { CreateItemData } from '../../../domain/types/items.types';

export interface ImportItemsToProjectCommand {
  userId: string;
  projectId: string;
  itemIds: string[];
}

export interface ImportItemsToProjectResult {
  success: boolean;
  importedCount: number;
}

/**
 * Command Use Case — Import Items To Project
 *
 * Copies existing personal library items into a project workspace.
 * For each item:
 *  1. Checks project membership
 *  2. Skips duplicates (by DOI, citationKey, or title)
 *  3. Creates a new project-scoped copy via ItemsService.createItem()
 *
 * Extracted from ItemsService.importItemsToProject().
 *
 * Application layer. PrismaService is used here because project-membership
 * checks require cross-BC queries (Project model lives outside catalog).
 * This is an acceptable pragmatic boundary — the alternative would require a
 * dedicated ProjectAccessPort or IAM integration, which is a separate task.
 */
@Injectable()
export class ImportItemsToProjectUseCase {
  private readonly logger = new Logger(ImportItemsToProjectUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queryRepo: QueryRepository,
    // ItemsService is still used for the actual create path (transaction + outbox)
    // until CreateItemUseCase is wired to accept project imports natively.
    private readonly itemsService: ItemsService,
  ) {}

  async execute(
    command: ImportItemsToProjectCommand,
  ): Promise<ImportItemsToProjectResult> {
    const { userId, projectId, itemIds } = command;

    if (!itemIds || itemIds.length === 0) {
      return { success: true, importedCount: 0 };
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { members: true },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const isMember =
      project.createdById === userId ||
      project.members.some((m: any) => m.userId === userId);

    if (!isMember) {
      throw new ForbiddenException(
        'You do not have permission to import items to this project',
      );
    }

    const sourceItems = await this.queryRepo.findByIds(userId, itemIds);
    let importedCount = 0;

    for (const source of sourceItems) {
      // Skip duplicates — check by DOI, citationKey, or title in target project
      const existingInProject = await this.prisma.item.findFirst({
        where: {
          projectId,
          deletedAt: null,
          OR: [
            ...(source.doi ? [{ doi: source.doi }] : []),
            ...(source.citationKey
              ? [{ citationKey: source.citationKey }]
              : []),
            { title: source.title },
          ],
        },
      });

      if (existingInProject) {
        continue;
      }

      const primaryAttachment = source.attachments?.[0];
      const resolvedFileId = primaryAttachment?.fileId
        ? String(primaryAttachment.fileId)
        : (source as any).fileId
          ? String((source as any).fileId)
          : undefined;
      const resolvedFileUrl =
        primaryAttachment?.url || (source as any).fileUrl || undefined;
      const resolvedFilename =
        primaryAttachment?.filename ||
        primaryAttachment?.name ||
        (source as any).filename ||
        undefined;
      const resolvedMimeType =
        primaryAttachment?.mimeType || (source as any).mimeType || undefined;
      const resolvedSize =
        primaryAttachment?.size || (source as any).size || undefined;
      const resolvedFileHash =
        primaryAttachment?.fileHash || (source as any).fileHash || undefined;

      const createData: CreateItemData = {
        title: source.title,
        uploadedById: userId,
        year: source.year ?? undefined,
        doi: source.doi ?? undefined,
        abstract: source.abstract ?? undefined,
        itemType: source.itemType || 'journalArticle',
        publicationTitle: source.publicationTitle ?? undefined,
        publicationDate: source.publicationDate ?? undefined,
        publisher: source.publisher ?? undefined,
        place: source.place ?? undefined,
        volume: source.volume ?? undefined,
        issue: source.issue ?? undefined,
        section: source.section ?? undefined,
        partNumber: source.partNumber ?? undefined,
        partTitle: source.partTitle ?? undefined,
        pages: source.pages ?? undefined,
        series: source.series ?? undefined,
        seriesTitle: source.seriesTitle ?? undefined,
        seriesText: source.seriesText ?? undefined,
        issn: source.issn ?? undefined,
        isbn: source.isbn ?? undefined,
        pmid: source.pmid ?? undefined,
        pmcid: source.pmcid ?? undefined,
        url: source.url ?? undefined,
        language: source.language ?? undefined,
        journalAbbr: source.journalAbbr ?? undefined,
        shortTitle: source.shortTitle ?? undefined,
        rights: source.rights ?? undefined,
        license: source.license ?? undefined,
        citationKey: source.citationKey ?? undefined,
        libraryCatalog: source.libraryCatalog ?? undefined,
        archive: source.archive ?? undefined,
        archiveLocation: source.archiveLocation ?? undefined,
        callNumber: source.callNumber ?? undefined,
        extra: source.extra ?? undefined,
        arxivId: source.arxivId ?? undefined,
        citationCount: source.citationCount ?? undefined,
        referenceCount: source.referenceCount ?? undefined,
        openAccessPdfUrl: source.openAccessPdfUrl ?? undefined,
        fileId: resolvedFileId,
        fileUrl: resolvedFileUrl,
        filename: resolvedFilename,
        mimeType: resolvedMimeType,
        size: resolvedSize,
        fileHash: resolvedFileHash,
        tags:
          source.itemTags?.map((it: any) => it.tag?.name).filter(Boolean) || [],
        notes:
          source.notesList?.map((n: any) => ({
            title: n.title,
            contentMd: n.contentMd,
            content: n.contentMd,
            tags: n.tags || [],
          })) || [],
        creators: source.contributors?.map((c: any) => ({
          creatorType: c.creatorType || 'author',
          firstName: c.firstName || '',
          lastName: c.lastName || '',
          fullName: c.fullName || '',
          name: c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          orderIndex: c.orderIndex ?? 0,
        })),
        identifiers: source.identifiers?.map((i: any) => ({
          type: i.type,
          value: i.value,
          canonicalUri: i.canonicalUri,
        })),
      };

      await this.itemsService.createItem(
        userId,
        createData,
        { projectId, source: 'external_sync' },
        projectId,
      );

      importedCount++;
    }

    return { success: true, importedCount };
  }
}
