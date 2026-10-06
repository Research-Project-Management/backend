import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Inject,
  Logger,
} from '@nestjs/common';
import {
  PROJECT_ACCESS_PORT,
  IProjectAccessPort,
} from '../ports/project-access.port';
import {
  ITEM_REPOSITORY_PORT,
  IItemRepositoryPort,
} from '../ports/item-repository.port';
import { CreateItemUseCase } from './create-item.use-case';

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
 * Clean Architecture & DDD:
 * Depends strictly on Domain Ports (IProjectAccessPort, IItemRepositoryPort)
 * and CreateItemUseCase. Zero raw Prisma or concrete repository coupling.
 */
@Injectable()
export class ImportItemsToProjectUseCase {
  private readonly logger = new Logger(ImportItemsToProjectUseCase.name);

  constructor(
    @Inject(PROJECT_ACCESS_PORT)
    private readonly projectAccess: IProjectAccessPort,
    @Inject(ITEM_REPOSITORY_PORT)
    private readonly itemRepo: IItemRepositoryPort,
    private readonly createItemUseCase: CreateItemUseCase,
  ) {}

  async execute(
    command: ImportItemsToProjectCommand,
  ): Promise<ImportItemsToProjectResult> {
    const { userId, projectId, itemIds } = command;

    if (!itemIds || itemIds.length === 0) {
      return { success: true, importedCount: 0 };
    }

    const hasAccess = await this.projectAccess.canAccessProject(
      userId,
      projectId,
    );
    if (!hasAccess) {
      throw new ForbiddenException(
        'You do not have permission to import items to this project',
      );
    }

    // Batch fetch source items in parallel instead of sequential roundtrips
    const sourceItems = (
      await Promise.all(
        itemIds.map((itemId) => this.itemRepo.findById(userId, itemId)),
      )
    ).filter((item): item is NonNullable<typeof item> => item !== null);

    if (sourceItems.length === 0) {
      return { success: true, importedCount: 0 };
    }

    // Prefetch existing target project items to build O(1) in-memory deduplication lookup sets
    const existingInProject = await this.itemRepo.findMany(userId, {
      projectId,
      limit: 1000,
    });

    const existingDois = new Set<string>();
    const existingCitationKeys = new Set<string>();
    const existingTitles = new Set<string>();

    for (const it of existingInProject.items) {
      if (it.doi) existingDois.add(it.doi.toLowerCase().trim());
      if (it.citationKey) existingCitationKeys.add(it.citationKey.trim());
      if (it.title) existingTitles.add(it.title.toLowerCase().trim());
    }

    let importedCount = 0;

    for (const source of sourceItems) {
      const normDoi = source.doi ? source.doi.toLowerCase().trim() : null;
      const normKey = source.citationKey ? source.citationKey.trim() : null;
      const normTitle = source.title ? source.title.toLowerCase().trim() : null;

      const isDuplicate =
        (normDoi && existingDois.has(normDoi)) ||
        (normKey && existingCitationKeys.has(normKey)) ||
        (normTitle && existingTitles.has(normTitle));

      if (isDuplicate) {
        continue;
      }

      await this.createItemUseCase.execute({
        userId,
        projectId,
        title: source.title,
        itemType: source.itemType,
        doi: source.doi,
        citationKey: source.citationKey,
        abstract: source.abstract,
        year: source.year,
        publicationTitle: source.publicationTitle,
        fields: source.fields,
      });

      // Track newly created item to prevent duplicates within the same batch
      if (normDoi) existingDois.add(normDoi);
      if (normKey) existingCitationKeys.add(normKey);
      if (normTitle) existingTitles.add(normTitle);

      importedCount++;
    }

    return { success: true, importedCount };
  }
}
